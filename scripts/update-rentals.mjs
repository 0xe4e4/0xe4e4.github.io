#!/usr/bin/env node
/**
 * Manual updater for src/data/rentals.json
 *
 *   npm run update:rentals
 *   npm run update:rentals -- --enrich-only   # add carMinutes / coords to existing JSON
 *
 * Not hooked into build/CI. Requests are delayed and page-capped.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '../src/data/rentals.json');
const GEO_CACHE_PATH = join(__dirname, '../src/data/geocode-cache.json');
const DATE_CACHE_PATH = join(__dirname, '../src/data/listing-dates-cache.json');

const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 〒273-0017 千葉県船橋市西浦１丁目１−１ (GSI AddressSearch) */
const DESTINATION = {
	label: '〒273-0017 千葉県船橋市西浦１丁目１−１',
	lat: 35.692646,
	lon: 139.966736,
};

const CITIES = [
	{
		code: '12204',
		name: '船橋市',
		suumoSlug: 'sc_funabashi',
		athomeSlug: 'funabashi-city',
	},
	{
		code: '12216',
		name: '習志野市',
		suumoSlug: 'sc_narashino',
		athomeSlug: 'narashino-city',
	},
	{
		code: '12203',
		name: '市川市',
		suumoSlug: 'sc_ichikawa',
		athomeSlug: 'ichikawa-city',
	},
	{
		code: '12106',
		name: '千葉市美浜区',
		suumoSlug: 'sc_chibashimihama',
		athomeSlug: 'chiba_mihama-city',
	},
	{
		code: '12227',
		name: '浦安市',
		suumoSlug: 'sc_urayasu',
		athomeSlug: 'urayasu-city',
	},
];

const LAYOUT_ORDER = ['1DK', '1LDK', '2K', '2DK', '3K', '3DK', '3LDK'];
const ALLOWED_LAYOUTS = new Set(LAYOUT_ORDER);
const MIN_BUILT_YEAR = 1981;
const MAX_WALK = 15;
const MAX_RENT_YEN = 100000;

const args = process.argv.slice(2);
const enrichOnly = args.includes('--enrich-only');
const datesOnly = args.includes('--dates-only');
const maxPages = Number(
	args.find((a) => a.startsWith('--pages='))?.split('=')[1] ?? 2,
);
const delayMs = Number(
	args.find((a) => a.startsWith('--delay='))?.split('=')[1] ?? 1800,
);
const sourcesArg =
	args.find((a) => a.startsWith('--sources='))?.split('=')[1] ??
	'suumo,yahoo,athome';
const enabledSources = new Set(sourcesArg.split(',').map((s) => s.trim()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cookieMap = new Map();

function rememberCookies(res) {
	const raw =
		typeof res.headers.getSetCookie === 'function'
			? res.headers.getSetCookie()
			: [];
	for (const cookie of raw) {
		const nv = String(cookie).split(';')[0];
		const i = nv.indexOf('=');
		if (i > 0) cookieMap.set(nv.slice(0, i), nv.slice(i + 1));
	}
}

function cookieHeader() {
	if (cookieMap.size === 0) return '';
	return [...cookieMap.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function isCaptchaHtml(html) {
	return /initGeetest|geetest|solvedCaptcha/i.test(html) && html.length < 40000;
}

async function fetchText(url, referer) {
	const headers = {
		'User-Agent': UA,
		Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
		'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
		...(referer ? { Referer: referer } : {}),
	};
	const cookies = cookieHeader();
	if (cookies) headers.Cookie = cookies;
	const res = await fetch(url, { headers, redirect: 'follow' });
	rememberCookies(res);
	const html = await res.text();
	if (isCaptchaHtml(html) || res.status === 403 || res.status === 405) {
		throw new Error(`blocked HTTP ${res.status} for ${url}`);
	}
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return html;
}

function stripTags(html) {
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/\s+/g, ' ')
		.trim();
}

function parseWalkMinutes(text) {
	const m = String(text).match(
		/歩\s*(\d+)\s*分|徒歩\s*(\d+)\s*分|(\d+)\s*分以内/,
	);
	if (!m) return null;
	return Number(m[1] || m[2] || m[3]);
}

function normalizeStationName(text) {
	const t = String(text || '').trim();
	if (!t) return '';
	const withEki = t.match(/([^/\s　]+駅)/);
	if (withEki) return withEki[1];
	const afterSlash = t.match(/\/\s*([^/\s　]+)/);
	if (afterSlash) {
		const n = afterSlash[1];
		return n.endsWith('駅') ? n : `${n}駅`;
	}
	return t.split(/\s|　/)[0] || '';
}

function parseBuiltYear(ageLabel, nowYear = new Date().getFullYear()) {
	if (/新築/.test(ageLabel)) return nowYear;
	const age = ageLabel.match(/築\s*(\d+)\s*年/);
	if (age) return nowYear - Number(age[1]);
	const y = ageLabel.match(/(19|20)\d{2}/);
	return y ? Number(y[0]) : null;
}

function parseAgeYears(
	ageLabel,
	builtYear,
	nowYear = new Date().getFullYear(),
) {
	if (/新築/.test(ageLabel || '')) return 0;
	const age = String(ageLabel || '').match(/築\s*(\d+)\s*年/);
	if (age) return Number(age[1]);
	if (builtYear != null) return Math.max(0, nowYear - builtYear);
	return null;
}

function normalizeLayout(raw) {
	const t = raw.replace(/\s+/g, '').toUpperCase();
	const m = t.match(/(\d)\s*(S?L?D?K|R)/);
	if (!m) return t;
	const n = m[1];
	const kind = m[2].replace(/^S/, '');
	if (kind === 'R') return 'ワンルーム';
	return `${n}${kind}`;
}

function parseArea(raw) {
	const m = String(raw)
		.replace(/,/g, '')
		.match(/([\d.]+)\s*m/i);
	return m ? Number(m[1]) : null;
}

function parseRentYen(label) {
	const t = String(label || '')
		.replace(/,/g, '')
		.trim();
	if (!t || t === '-' || t === '―') return null;
	const man = t.match(/([\d.]+)\s*万/);
	if (man) return Math.round(Number(man[1]) * 10000);
	const yen = t.match(/([\d]+)\s*円/);
	if (yen) return Number(yen[1]);
	const bare = Number(t);
	return Number.isFinite(bare) ? bare : null;
}

function cityFromAddress(address, fallback) {
	for (const c of CITIES) {
		if (address.includes(c.name)) return c.name;
	}
	return fallback;
}

const STRUCTURE_GROUP_BY_LABEL = {
	鉄筋コンクリート: '鉄筋系',
	鉄骨鉄筋コンクリート: '鉄筋系',
	プレキャストコンクリート: '鉄筋系',
	鉄筋ブロック: '鉄筋系',
	'SRC・RC': '鉄筋系',
	鉄筋系: '鉄筋系',
	鉄骨プレキャストコンクリート: '鉄骨系',
	鉄骨: '鉄骨系',
	重量鉄骨: '鉄骨系',
	軽量鉄骨: '鉄骨系',
	ALC: '鉄骨系',
	鉄骨系: '鉄骨系',
	木造: '木造',
	その他: 'その他',
};

const EXCLUDED_STRUCTURE_GROUPS = new Set(['木造']);

const YAHOO_STRUCTURE = {
	1: '鉄筋コンクリート',
	2: '鉄骨鉄筋コンクリート',
	3: 'プレキャストコンクリート',
	4: '鉄筋ブロック',
	5: '鉄骨プレキャストコンクリート',
	6: '鉄骨',
	7: '重量鉄骨',
	8: '軽量鉄骨',
	9: 'ALC',
	10: 'SRC・RC',
	11: '木造',
	99: 'その他',
};

const SUUMO_STRUCTURE_BY_KZ = {
	1: { structure: '鉄筋系', structureGroup: '鉄筋系' },
	2: { structure: '鉄骨系', structureGroup: '鉄骨系' },
	4: { structure: 'その他', structureGroup: 'その他' },
};

function normalizeStructure(structure, structureGroup) {
	const label = String(structure || '').trim();
	const group =
		structureGroup ||
		STRUCTURE_GROUP_BY_LABEL[label] ||
		(label ? 'その他' : '');
	return { structure: label || group || '', structureGroup: group || '' };
}

function baseListingFields(partial) {
	const builtYear = partial.builtYear ?? null;
	const buildingAgeLabel = partial.buildingAgeLabel || '';
	const { structure, structureGroup } = normalizeStructure(
		partial.structure,
		partial.structureGroup,
	);
	return {
		...partial,
		builtYear,
		buildingAgeLabel,
		structure,
		structureGroup,
		stationName: normalizeStationName(partial.station || ''),
		rentYen: parseRentYen(partial.rentLabel),
		ageYears: parseAgeYears(buildingAgeLabel, builtYear),
		carMinutes: partial.carMinutes ?? null,
		listedAt: partial.listedAt ?? null,
		sourceUpdatedAt: partial.sourceUpdatedAt ?? null,
		lat: partial.lat ?? null,
		lon: partial.lon ?? null,
		parking: typeof partial.parking === 'boolean' ? partial.parking : null,
		bikeParking:
			typeof partial.bikeParking === 'boolean' ? partial.bikeParking : null,
	};
}

function mentionsBikeParkingText(text) {
	const t = String(text || '');
	if (!t) return false;
	if (/バイク(?:置き?場|駐輪)|原付(?:置|可|駐)/.test(t)) return true;
	if (/駐輪場/.test(t)) {
		if (/駐輪場(?:なし|無|不可|空無|－|―|-)/.test(t)) return false;
		return true;
	}
	return false;
}

function isWoodenStructure(listing) {
	return (
		EXCLUDED_STRUCTURE_GROUPS.has(listing.structureGroup) ||
		/木造/.test(String(listing.structure || ''))
	);
}

function parseYahooParking(room) {
	if (!Array.isArray(room?.Pickouts)) return null;
	return room.Pickouts.includes('cr');
}

function parseAthomeParking(roomHtml) {
	const m = String(roomHtml).match(/<li([^>]*)>\s*駐車場（近隣含む）/);
	if (!m) return null;
	return !/disabled/.test(m[1] || '');
}

function parseSuumoParking(html) {
	const m = String(html).match(
		/<th[^>]*>\s*駐車場\s*<\/th>\s*<td>([\s\S]*?)<\/td>/,
	);
	if (!m) return null;
	const t = stripTags(m[1]);
	if (!t || t === '-' || t === '―' || t === '－') return false;
	if (/空無/.test(t)) return false;
	if (/なし|無し|^無$|不可/.test(t) && !/近隣/.test(t)) return false;
	return true;
}

function parseYahooBikeParking(room) {
	if (!Array.isArray(room?.Pickouts)) return null;
	return room.Pickouts.includes('bc') || room.Pickouts.includes('ba');
}

function parseAthomeBikeParking(blockHtml, roomHtml) {
	const hay = `${blockHtml}${roomHtml}`;
	for (const label of ['バイク置き場', '駐輪場']) {
		const m = hay.match(new RegExp(`<li([^>]*)>\\s*${label}(?:\\([^)]*\\))?`));
		if (m && !/disabled/.test(m[1] || '')) return true;
	}
	const modal = hay.match(/data-modal-msg="([^"]*)"/);
	if (modal && mentionsBikeParkingText(modal[1])) return true;
	return null;
}

function parseSuumoBikeParking(html) {
	const raw = String(html);
	for (const m of raw.matchAll(/labeloption[^>]*>([\s\S]*?)<\//g)) {
		if (mentionsBikeParkingText(stripTags(m[1]))) return true;
	}
	for (const m of raw.matchAll(/>([^<]{0,240}(?:駐輪|バイク)[^<]{0,240})</g)) {
		if (mentionsBikeParkingText(m[1])) return true;
	}
	return false;
}

function passesFilters(listing) {
	if (!ALLOWED_LAYOUTS.has(listing.layout)) return false;
	if (listing.walkMinutes != null && listing.walkMinutes > MAX_WALK)
		return false;
	if (listing.rentYen != null && listing.rentYen > MAX_RENT_YEN) return false;
	if (listing.builtYear != null && listing.builtYear < MIN_BUILT_YEAR)
		return false;
	if (isWoodenStructure(listing)) return false;
	if (!listing.independentWashbasin) return false;
	const cityNames = CITIES.map((c) => c.name);
	if (
		listing.address &&
		!cityNames.some((name) => listing.address.includes(name))
	)
		return false;
	return true;
}

/** ---- SUUMO ---- */

function buildSuumoUrl(cityCode, page, kz) {
	const params = new URLSearchParams();
	params.set('ar', '030');
	params.set('bs', '040');
	params.set('ta', '12');
	params.set('sc', cityCode);
	params.set('et', String(MAX_WALK));
	params.set('kt', String(Math.round(MAX_RENT_YEN / 10000)));
	params.set('po1', '25');
	params.set('pc', '50');
	for (const md of ['03', '04', '05', '06', '08', '09', '10'])
		params.append('md', md);
	params.append('tc', '0400502');
	if (kz) params.append('kz', String(kz));
	if (page > 1) params.set('page', String(page));
	return `https://suumo.jp/jj/chintai/ichiran/FR301FC001/?${params.toString()}`;
}

function parseSuumo(html, city, structureInfo) {
	const listings = [];
	if (/エラー｜SUUMO/.test(html)) {
		console.warn(`  SUUMO error page for ${city.name}`);
		return listings;
	}

	const blocks = html.split(/<div class="cassetteitem">/).slice(1);
	for (const block of blocks) {
		const title = stripTags(
			(block.match(/cassetteitem_content-title[^>]*>([\s\S]*?)<\//) || [])[1] ||
				'',
		);
		const address = stripTags(
			(block.match(/cassetteitem_detail-col1[^>]*>([\s\S]*?)<\//) || [])[1] ||
				'',
		);
		const stationRaw = stripTags(
			(block.match(
				/cassetteitem_detail-col2[\s\S]*?cassetteitem_detail-text[^>]*>([\s\S]*?)<\//,
			) || [])[1] || '',
		);
		const ageRaw = stripTags(
			(block.match(/cassetteitem_detail-col3[\s\S]*?<div>([\s\S]*?)<\/div>/) ||
				[])[1] || '',
		);
		const walkMinutes = parseWalkMinutes(stationRaw);
		const builtYear = parseBuiltYear(ageRaw);

		const rows = block.match(/<tbody>([\s\S]*?)<\/tbody>/g) || [];
		for (const row of rows) {
			const tds = [...row.matchAll(/<td[\s\S]*?>([\s\S]*?)<\/td>/g)].map(
				(m) => m[1],
			);
			if (tds.length < 9) continue;

			const floorLabel = stripTags(tds[2] || '');
			const rentLabel = stripTags(
				(tds[3].match(/cassetteitem_price--rent[^>]*>([\s\S]*?)<\//) ||
					[])[1] || tds[3],
			);
			const managementFeeLabel = stripTags(
				(tds[3].match(
					/cassetteitem_price--administration[^>]*>([\s\S]*?)<\//,
				) || [])[1] || '',
			);
			const layout = normalizeLayout(
				stripTags(
					(tds[5].match(/cassetteitem_madori[^>]*>([\s\S]*?)<\//) || [])[1] ||
						tds[5],
				),
			);
			const areaSqm = parseArea(
				stripTags(
					(tds[5].match(/cassetteitem_menseki[^>]*>([\s\S]*?)<\//) || [])[1] ||
						'',
				),
			);
			const href =
				(row.match(/href="(\/chintai\/jnc_[^"]+)"/) ||
					row.match(/href="(https:\/\/suumo\.jp\/chintai\/jnc_[^"]+)"/) ||
					[])[1] || '';
			if (!href) continue;
			const url = href.startsWith('http') ? href : `https://suumo.jp${href}`;
			const idMatch = url.match(/bc=(\d+)/) || url.match(/jnc_(\d+)/);
			const id = `suumo:${idMatch?.[1] || url}`;

			const listing = baseListingFields({
				id,
				source: 'suumo',
				title: title || address,
				address,
				station: stationRaw,
				walkMinutes,
				layout,
				areaSqm,
				rentLabel,
				managementFeeLabel,
				buildingAgeLabel: ageRaw,
				builtYear,
				floorLabel,
				url,
				city: cityFromAddress(address, city.name),
				parking: null,
				bikeParking: null,
				independentWashbasin: true,
				structure: structureInfo?.structure || '',
				structureGroup: structureInfo?.structureGroup || '',
			});
			if (passesFilters(listing)) listings.push(listing);
		}
	}
	return listings;
}

async function fetchSuumo() {
	const out = [];
	for (const city of CITIES) {
		for (const [kz, structureInfo] of Object.entries(SUUMO_STRUCTURE_BY_KZ)) {
			console.log(`SUUMO ${city.name} ${structureInfo.structure}…`);
			for (let page = 1; page <= maxPages; page++) {
				const url = buildSuumoUrl(city.code, page, kz);
				try {
					const html = await fetchText(
						url,
						`https://suumo.jp/chintai/chiba/${city.suumoSlug}/`,
					);
					const items = parseSuumo(html, city, structureInfo);
					console.log(`  page ${page}: ${items.length} matching rooms`);
					out.push(...items);
					if (!/cassetteitem/.test(html)) break;
					const next =
						html.includes(`page=${page + 1}`) ||
						html.includes(`page=${page + 1}&`);
					if (!next && page > 1) break;
				} catch (err) {
					console.warn(`  failed page ${page}:`, err.message);
					break;
				}
				await sleep(delayMs);
			}
		}
	}
	return out;
}

/** ---- Yahoo ---- */

function buildYahooUrl(cityCode, page) {
	const params = new URLSearchParams();
	params.set('min_st', String(MAX_WALK));
	params.set('max_pr', String(Math.round(MAX_RENT_YEN / 10000)));
	for (const n of [3, 4, 5, 6, 8, 9, 10]) params.append('rl_dtl', String(n));
	params.append('po', 'ws');
	if (page > 1) params.set('page', String(page));
	return `https://realestate.yahoo.co.jp/rent/search/03/12/${cityCode}/?${params.toString()}`;
}

function extractYahooContext(html) {
	const m = html.match(
		/window\.__SERVER_SIDE_CONTEXT__\s*=\s*(\{[\s\S]*?\});\s*\/\*\]\]>/,
	);
	if (!m) return null;
	return Function(`"use strict"; return (${m[1]});`)();
}

const YAHOO_LAYOUT = {
	3: '1DK',
	4: '1LDK',
	5: '2K',
	6: '2DK',
	8: '3K',
	9: '3DK',
	10: '3LDK',
};

function parseYahooCoords(raw) {
	if (!raw) return { lat: null, lon: null };
	const [lat, lon] = String(raw)
		.split(',')
		.map((n) => Number(n.trim()));
	if (!Number.isFinite(lat) || !Number.isFinite(lon))
		return { lat: null, lon: null };
	return { lat, lon };
}

function parseYahoo(html, city) {
	const ctx = extractYahooContext(html);
	if (!ctx?.page?.properties) {
		console.warn(`  Yahoo: no SERVER_SIDE_CONTEXT for ${city.name}`);
		return { listings: [], lastPage: 1 };
	}
	const lastPage = ctx.page.paginationContext?.lastPage ?? 1;
	const listings = [];

	for (const building of ctx.page.properties) {
		if (Number(building.StructureDiv) === 11) continue;
		const address = building.LocationView?.AddressName || '';
		const transports = building.Transports || [];
		const nearest = transports
			.filter((t) => t.MinutesFromStation != null)
			.sort((a, b) => a.MinutesFromStation - b.MinutesFromStation)[0];
		const station = nearest?.Label || transports[0]?.Label || '';
		const walkMinutes =
			nearest?.MinutesFromStation ?? parseWalkMinutes(station);
		const builtOn = building.BuiltOn || '';
		const builtYear = builtOn ? Number(String(builtOn).slice(0, 4)) : null;
		const ageLabel =
			building.YearsOld != null ? `築${building.YearsOld}年` : builtOn || '';
		const { lat, lon } = parseYahooCoords(building.CoordinatesWgs);
		const yahooStructure =
			YAHOO_STRUCTURE[building.StructureDiv] ||
			(building.StructureDiv != null ? String(building.StructureDiv) : '');

		for (const room of building.GroupProperties || []) {
			const layout =
				YAHOO_LAYOUT[room.DetailRoomLayout] ||
				String(room.DetailRoomLayout || '');
			const id = `yahoo:${room.PropertyId}`;
			const url = `https://realestate.yahoo.co.jp/rent/detail/${room.PropertyId}/`;
			const floorNum =
				room.FloorNum != null && room.FloorNum !== ''
					? `${room.FloorNum}階`
					: '';

			const listing = baseListingFields({
				id,
				source: 'yahoo',
				title: building.BuildingName || address,
				address,
				station,
				walkMinutes,
				layout,
				areaSqm: parseArea(room.MonopolyAreaLabel || ''),
				rentLabel: stripTags(room.PriceLabel || ''),
				managementFeeLabel: stripTags(room.MonthlyManagementCostLabel || ''),
				buildingAgeLabel: ageLabel,
				builtYear,
				floorLabel: floorNum,
				url,
				city: cityFromAddress(address, city.name),
				parking: parseYahooParking(room),
				bikeParking: parseYahooBikeParking(room),
				independentWashbasin: true,
				structure: yahooStructure,
				lat,
				lon,
			});
			if (passesFilters(listing)) listings.push(listing);
		}
	}
	return { listings, lastPage };
}

async function fetchYahoo() {
	const out = [];
	for (const city of CITIES) {
		console.log(`Yahoo ${city.name}…`);
		let lastPage = maxPages;
		for (let page = 1; page <= Math.min(maxPages, lastPage); page++) {
			const url = buildYahooUrl(city.code, page);
			try {
				const html = await fetchText(
					url,
					'https://realestate.yahoo.co.jp/rent/',
				);
				const { listings, lastPage: lp } = parseYahoo(html, city);
				lastPage = lp;
				console.log(
					`  page ${page}/${lastPage}: ${listings.length} matching rooms`,
				);
				out.push(...listings);
			} catch (err) {
				console.warn(`  failed page ${page}:`, err.message);
				break;
			}
			await sleep(delayMs);
		}
	}
	return out;
}

/** ---- At Home ---- */

const ATHOME_MADORI = [
	'km004',
	'km005',
	'km008',
	'km009',
	'km013',
	'km014',
	'km015',
];

function buildAthomeUrl(slug, page) {
	const params = new URLSearchParams();
	params.set('PRICETO', 'kc115');
	params.set('EKITOHO', 'ke005');
	for (const md of ATHOME_MADORI) params.append('MADORI[]', md);
	params.append('KODAWARI[]', 'B15');
	params.append('SHUMOKU[]', 'kb001');
	params.append('SHUMOKU[]', 'kb002');
	params.append('TATEKOUZOU[]', 'kh001');
	params.append('TATEKOUZOU[]', 'kh002');
	params.append('TATEKOUZOU[]', 'kh004');
	const qs = params.toString();
	const base = `https://www.athome.co.jp/chintai/chiba/${slug}/list/`;
	return page > 1 ? `${base}page${page}/?${qs}` : `${base}?${qs}`;
}

function parseAthomeHomeText(block) {
	const raw =
		(block.match(/u-icon--home-mini[\s\S]*?<dd>([\s\S]*?)<\/dd>/) || [])[1] ||
		'';
	return stripTags(raw);
}

function parseAthome(html, city) {
	const listings = [];
	if (isCaptchaHtml(html)) {
		console.warn(`  At Home captcha page for ${city.name}`);
		return listings;
	}
	const buildings = html.split(/<div class="p-property p-property--building/);
	for (const block of buildings.slice(1)) {
		const title = stripTags(
			(block.match(/p-property__title--building[^>]*>([\s\S]*?)<\//) ||
				[])[1] || '',
		);
		const addressRaw = stripTags(
			(block.match(/u-icon--map-mini[\s\S]*?<strong>([\s\S]*?)<\/strong>/) ||
				[])[1] || '',
		);
		const address = addressRaw.includes('千葉県')
			? addressRaw
			: addressRaw
				? `千葉県${addressRaw}`
				: '';
		const stationRaw = stripTags(
			(block.match(/u-icon--train-mini[\s\S]*?<dd>([\s\S]*?)<\/dd>/) ||
				[])[1] || '',
		);
		const homeText = parseAthomeHomeText(block);
		const walkMinutes = parseWalkMinutes(stationRaw);
		const builtYear = parseBuiltYear(homeText);
		const ageMatch = homeText.match(/築\s*\d+\s*年/);
		const yearMatch = homeText.match(/(19|20)\d{2}年/);
		const buildingAgeLabel = ageMatch
			? ageMatch[0]
			: yearMatch
				? yearMatch[0]
				: homeText;
		let structure = '';
		for (const label of Object.keys(STRUCTURE_GROUP_BY_LABEL)) {
			if (label !== 'その他' && homeText.includes(label)) {
				structure = label;
				break;
			}
		}

		const rooms = block.split(/data-bukken-no="/).slice(1);
		for (const room of rooms) {
			const bukkenNo = (room.match(/^(\d+)/) || [])[1];
			if (!bukkenNo) continue;
			const rentNum = (room.match(
				/p-property__information-rent[^>]*>([\s\S]*?)<\//,
			) || [])[1];
			const rentLabel = rentNum ? `${stripTags(rentNum)}万円` : '';
			const feeSpan = (room.match(
				/p-property__information-rent[\s\S]*?<\/b>[\s\S]*?万円[\s\S]*?<span>([\s\S]*?)<\/span>/,
			) || [])[1];
			const managementFeeLabel = stripTags(feeSpan || '');
			const layout = normalizeLayout(
				stripTags(
					(room.match(/p-property__floor[^>]*>([\s\S]*?)<\//) || [])[1] || '',
				),
			);
			const areaSqm = parseArea(
				stripTags(
					(room.match(
						/p-property__floor[\s\S]*?<\/div>\s*<span>([\s\S]*?)<\/span>/,
					) || [])[1] || '',
				),
			);
			const floorRaw = stripTags(
				(room.match(
					/p-property__room-number list_width--two[^>]*>([\s\S]*?)<\//,
				) || [])[1] || '',
			);
			const floorLabel = floorRaw
				? /階/.test(floorRaw)
					? floorRaw
					: `${floorRaw}階`
				: '';
			const listing = baseListingFields({
				id: `athome:${bukkenNo}`,
				source: 'athome',
				title: title || address,
				address,
				station: stationRaw,
				walkMinutes,
				layout,
				areaSqm,
				rentLabel,
				managementFeeLabel,
				buildingAgeLabel,
				builtYear,
				floorLabel,
				url: `https://www.athome.co.jp/chintai/${bukkenNo}/`,
				city: cityFromAddress(address, city.name),
				parking: parseAthomeParking(room),
				bikeParking: parseAthomeBikeParking(block, room),
				independentWashbasin: true,
				structure,
			});
			if (passesFilters(listing)) listings.push(listing);
		}
	}
	return listings;
}

async function fetchAthome() {
	const out = [];
	for (const city of CITIES) {
		console.log(`At Home ${city.name}…`);
		let blocked = false;
		for (let page = 1; page <= maxPages; page++) {
			const url = buildAthomeUrl(city.athomeSlug, page);
			try {
				const html = await fetchText(url, 'https://www.athome.co.jp/chintai/');
				if (!/p-property--building/.test(html)) {
					console.log(`  page ${page}: no buildings`);
					break;
				}
				const items = parseAthome(html, city);
				console.log(`  page ${page}: ${items.length} matching rooms`);
				out.push(...items);
			} catch (err) {
				console.warn(`  failed page ${page}: ${err.message}`);
				if (/blocked/.test(err.message)) blocked = true;
				break;
			}
			await sleep(delayMs);
		}
		if (blocked) {
			console.warn('  At Home blocked further requests; stopping source.');
			break;
		}
	}
	return out;
}

/** ---- Geocode + car minutes ---- */

function loadGeoCache() {
	if (!existsSync(GEO_CACHE_PATH)) return {};
	try {
		return JSON.parse(readFileSync(GEO_CACHE_PATH, 'utf8'));
	} catch {
		return {};
	}
}

function saveGeoCache(cache) {
	writeFileSync(
		GEO_CACHE_PATH,
		`${JSON.stringify(cache, null, '\t')}\n`,
		'utf8',
	);
}

function normalizeAddressKey(address) {
	return String(address || '')
		.replace(/\s+/g, '')
		.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
		.replace(/[ー−‐-]/g, '-')
		.replace(/丁目/g, '-')
		.replace(/番/g, '-')
		.replace(/号/g, '');
}

async function geocodeAddress(address, cache) {
	const key = normalizeAddressKey(address);
	if (!key) return { hit: null, fetched: false };
	if (Object.prototype.hasOwnProperty.call(cache, key)) {
		return { hit: cache[key], fetched: false };
	}

	const url = new URL('https://msearch.gsi.go.jp/address-search/AddressSearch');
	url.searchParams.set('q', address);
	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': UA, Accept: 'application/json' },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		const feature = Array.isArray(data) ? data[0] : null;
		const coords = feature?.geometry?.coordinates;
		if (!coords) {
			cache[key] = null;
			return { hit: null, fetched: true };
		}
		const hit = { lon: coords[0], lat: coords[1] };
		cache[key] = hit;
		return { hit, fetched: true };
	} catch (err) {
		console.warn(`  geocode failed: ${address} (${err.message})`);
		cache[key] = null;
		return { hit: null, fetched: true };
	}
}

async function fillCoordinates(listings) {
	const cache = loadGeoCache();
	let lookups = 0;
	for (const item of listings) {
		if (item.lat != null && item.lon != null) continue;
		const { hit, fetched } = await geocodeAddress(item.address, cache);
		if (hit) {
			item.lat = hit.lat;
			item.lon = hit.lon;
		}
		if (fetched) {
			lookups += 1;
			if (lookups % 20 === 0) {
				saveGeoCache(cache);
				console.log(`  geocoded ${lookups} addresses…`);
			}
			await sleep(120);
		}
	}
	saveGeoCache(cache);
	console.log(
		`Geocode done (${lookups} lookups, cache ${Object.keys(cache).length})`,
	);
}

async function osrmDurations(sources) {
	/** @type {Map<string, number>} */
	const out = new Map();
	const batchSize = 40;
	for (let i = 0; i < sources.length; i += batchSize) {
		const batch = sources.slice(i, i + batchSize);
		const coords = [
			...batch.map((s) => `${s.lon},${s.lat}`),
			`${DESTINATION.lon},${DESTINATION.lat}`,
		].join(';');
		const destIndex = batch.length;
		const sourcesParam = batch.map((_, idx) => idx).join(';');
		const url = `https://router.project-osrm.org/table/v1/driving/${coords}?sources=${sourcesParam}&destinations=${destIndex}&annotations=duration`;
		try {
			const res = await fetch(url, { headers: { 'User-Agent': UA } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			if (data.code !== 'Ok' || !data.durations)
				throw new Error(data.message || data.code);
			batch.forEach((src, idx) => {
				const sec = data.durations[idx]?.[0];
				if (sec != null && Number.isFinite(sec)) {
					out.set(src.key, Math.max(1, Math.round(sec / 60)));
				}
			});
		} catch (err) {
			console.warn(`  OSRM batch failed: ${err.message}`);
		}
		await sleep(400);
	}
	return out;
}

async function fillCarMinutes(listings) {
	const unique = new Map();
	for (const item of listings) {
		if (item.lat == null || item.lon == null) continue;
		const key = `${item.lat.toFixed(5)},${item.lon.toFixed(5)}`;
		if (!unique.has(key))
			unique.set(key, { key, lat: item.lat, lon: item.lon });
	}
	console.log(`OSRM routing for ${unique.size} unique points → destination…`);
	const durations = await osrmDurations([...unique.values()]);
	let filled = 0;
	for (const item of listings) {
		if (item.lat == null || item.lon == null) {
			item.carMinutes = null;
			continue;
		}
		const key = `${item.lat.toFixed(5)},${item.lon.toFixed(5)}`;
		const mins = durations.get(key);
		item.carMinutes = mins ?? null;
		if (mins != null) filled += 1;
	}
	console.log(`Car minutes filled for ${filled}/${listings.length} listings`);
}

function toIsoDate(raw) {
	const t = String(raw || '').trim();
	if (!t || t === '-' || t === '―' || t === 'なし') return null;
	const m = t.match(/(20\d{2})[/\-年.](\d{1,2})[/\-月.](\d{1,2})/);
	if (!m) return null;
	return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function loadJsonCache(path) {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return {};
	}
}

function parseSuumoDates(html) {
	const published = html.match(/情報公開日<\/th>\s*<td>([^<]+)/);
	const updated = html.match(/情報更新日<\/th>\s*<td>([^<]+)/);
	return {
		listedAt: toIsoDate(published?.[1]),
		sourceUpdatedAt: toIsoDate(updated?.[1]),
	};
}

function parseYahooDetailDates(html) {
	const ctx = extractYahooContext(html);
	const prop = ctx?.page?.property;
	if (!prop) return { listedAt: null, sourceUpdatedAt: null };
	return {
		listedAt: toIsoDate(prop.InfoOpenDate),
		sourceUpdatedAt: toIsoDate(prop.InfoUpdate),
	};
}

function parseAthomeDates(html) {
	const published = html.match(
		/情報公開日[\s\S]{0,80}?((?:20\d{2})[/\-年.]\d{1,2}[/\-月.]\d{1,2})/,
	);
	const updated = html.match(
		/(?:情報更新日|更新日)[\s\S]{0,80}?((?:20\d{2})[/\-年.]\d{1,2}[/\-月.]\d{1,2})/,
	);
	return {
		listedAt: toIsoDate(published?.[1]),
		sourceUpdatedAt: toIsoDate(updated?.[1]),
	};
}

function parseListingDates(item, html) {
	if (item.source === 'suumo') return parseSuumoDates(html);
	if (item.source === 'yahoo') return parseYahooDetailDates(html);
	if (item.source === 'athome') return parseAthomeDates(html);
	return { listedAt: null, sourceUpdatedAt: null };
}

function refererFor(item) {
	if (item.source === 'suumo') return 'https://suumo.jp/';
	if (item.source === 'yahoo') return 'https://realestate.yahoo.co.jp/';
	return 'https://www.athome.co.jp/chintai/';
}

async function mapPool(items, limit, fn) {
	let index = 0;
	async function worker() {
		while (index < items.length) {
			const current = index;
			index += 1;
			await fn(items[current], current);
		}
	}
	const n = Math.min(limit, items.length) || 0;
	await Promise.all(Array.from({ length: n }, () => worker()));
}

async function fillListingDates(listings) {
	const cache = loadJsonCache(DATE_CACHE_PATH);
	const pending = listings.filter((item) => {
		const hit = cache[item.id];
		if (hit) {
			item.listedAt = hit.listedAt ?? null;
			item.sourceUpdatedAt = hit.sourceUpdatedAt ?? null;
			if (item.parking == null && typeof hit.parking === 'boolean') {
				item.parking = hit.parking;
			} else if (
				item.source === 'suumo' &&
				item.parking == null &&
				!Object.prototype.hasOwnProperty.call(hit, 'parking')
			) {
				// Older cache rows came from parking-required searches.
				item.parking = true;
			}
			if (typeof hit.bikeParking === 'boolean') {
				item.bikeParking = hit.bikeParking;
			}
			if (
				item.source === 'suumo' &&
				item.bikeParking == null &&
				!Object.prototype.hasOwnProperty.call(hit, 'bikeParking')
			) {
				return true;
			}
			return false;
		}
		if (item.listedAt || item.sourceUpdatedAt) {
			cache[item.id] = {
				listedAt: item.listedAt,
				sourceUpdatedAt: item.sourceUpdatedAt,
				parking: typeof item.parking === 'boolean' ? item.parking : null,
				bikeParking:
					typeof item.bikeParking === 'boolean' ? item.bikeParking : null,
			};
			return false;
		}
		return true;
	});
	console.log(
		`Detail dates: ${pending.length} to fetch, ${listings.length - pending.length} cached`,
	);

	let done = 0;
	let athomeBlocked = false;
	await mapPool(pending, 4, async (item) => {
		if (item.source === 'athome' && athomeBlocked) {
			cache[item.id] = { listedAt: null, sourceUpdatedAt: null };
			return;
		}
		try {
			const html = await fetchText(item.url, refererFor(item));
			const dates = parseListingDates(item, html);
			item.listedAt = dates.listedAt;
			item.sourceUpdatedAt = dates.sourceUpdatedAt;
			if (item.source === 'suumo') {
				if (item.parking == null) {
					const parsed = parseSuumoParking(html);
					if (typeof parsed === 'boolean') item.parking = parsed;
				}
				if (item.bikeParking == null) {
					item.bikeParking = parseSuumoBikeParking(html);
				}
			}
			cache[item.id] = {
				...dates,
				parking: typeof item.parking === 'boolean' ? item.parking : null,
				bikeParking:
					typeof item.bikeParking === 'boolean' ? item.bikeParking : null,
			};
		} catch (err) {
			console.warn(`  date fetch failed ${item.id}: ${err.message}`);
			cache[item.id] = { listedAt: null, sourceUpdatedAt: null };
			if (item.source === 'athome' && /blocked/.test(err.message)) {
				athomeBlocked = true;
			}
		}
		done += 1;
		if (done % 40 === 0) {
			writeFileSync(
				DATE_CACHE_PATH,
				`${JSON.stringify(cache, null, '\t')}\n`,
				'utf8',
			);
			console.log(`  dates ${done}/${pending.length}…`);
		}
		await sleep(item.source === 'athome' ? 600 : 250);
	});

	const keep = new Set(listings.map((item) => item.id));
	for (const key of Object.keys(cache)) {
		if (!keep.has(key)) delete cache[key];
	}
	writeFileSync(
		DATE_CACHE_PATH,
		`${JSON.stringify(cache, null, '\t')}\n`,
		'utf8',
	);
	const withDate = listings.filter(
		(item) => item.listedAt || item.sourceUpdatedAt,
	).length;
	console.log(`Dates filled for ${withDate}/${listings.length} listings`);
}

function normalizeExistingListing(item) {
	return baseListingFields({
		...item,
		station: item.station || '',
		rentLabel: item.rentLabel || '',
		buildingAgeLabel: item.buildingAgeLabel || '',
		builtYear: item.builtYear ?? null,
		lat: item.lat ?? null,
		lon: item.lon ?? null,
		carMinutes: item.carMinutes ?? null,
		structure: item.structure || '',
		structureGroup: item.structureGroup || '',
		listedAt: item.listedAt ?? null,
		sourceUpdatedAt: item.sourceUpdatedAt ?? null,
	});
}

function dedupe(listings) {
	const byKey = new Map();
	for (const item of listings) {
		const key = [
			item.source,
			item.address,
			item.layout,
			item.rentLabel,
			item.floorLabel,
			item.areaSqm ?? '',
		].join('|');
		if (!byKey.has(key)) byKey.set(key, item);
	}
	return [...byKey.values()].sort((a, b) => {
		const ca = a.carMinutes ?? 999;
		const cb = b.carMinutes ?? 999;
		if (ca !== cb) return ca - cb;
		return (a.rentYen ?? 0) - (b.rentYen ?? 0);
	});
}

function buildSnapshot(listings) {
	return {
		updatedAt: new Date().toISOString(),
		criteria: {
			destination: DESTINATION.label,
			destinationLat: DESTINATION.lat,
			destinationLon: DESTINATION.lon,
			maxCarMinutes: 20,
			maxWalkMinutes: MAX_WALK,
			maxRentYen: MAX_RENT_YEN,
			layouts: [...LAYOUT_ORDER],
			minBuiltYear: MIN_BUILT_YEAR,
			requireParking: false,
			requireIndependentWashbasin: true,
			commuteAreaNote:
				'車通勤分は OSRM（一般道想定）の概算。渋滞・有料道路利用は含まない。駅徒歩は掲載の最寄駅徒歩。',
			cities: CITIES.map(({ code, name }) => ({ code, name })),
		},
		listings,
		notes: [
			'この JSON は GitHub Actions（1日3回: 9時・14時・20時 JST）で更新する。ビルド時には取得しない。',
			'SUUMO: 洗面所独立。木造は除外。駐車場は詳細ページから取得し、ページ上で絞り込む。',
			'Yahoo!不動産: 洗面台（洗面所独立の近似）。木造は除外。駐車場は設備フラグから取得。',
			'アットホーム: 洗面所独立。木造は除外。駐車場は設備表示から取得。ボット対策で取得できない場合あり。',
			'掲載日・更新日は各サイトの詳細ページから取得。2日以内のものは一覧でハイライトする。',
			'車通勤時間は国土地理院ジオコード + OSRM の概算。最新の空室・条件は必ず元ページで確認すること。',
		],
	};
}

async function main() {
	let listings;
	if (enrichOnly || datesOnly) {
		console.log(
			`${datesOnly ? 'Dates-only' : 'Enrich-only'}: reading existing rentals.json…`,
		);
		const existing = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
		listings = existing.listings.map(normalizeExistingListing);
	} else {
		console.log(
			`Updating rentals (pages≤${maxPages}, delay=${delayMs}ms, sources=${[...enabledSources]})`,
		);
		const collected = [];
		if (enabledSources.has('suumo')) collected.push(...(await fetchSuumo()));
		if (enabledSources.has('yahoo')) collected.push(...(await fetchYahoo()));
		if (enabledSources.has('athome')) collected.push(...(await fetchAthome()));
		listings = dedupe(collected);
	}

	listings = listings.filter(passesFilters);

	if (!datesOnly) {
		await fillCoordinates(listings);
		await fillCarMinutes(listings);
	}
	await fillListingDates(listings);
	listings = dedupe(listings);

	const snapshot = buildSnapshot(listings);
	writeFileSync(OUT_PATH, `${JSON.stringify(snapshot, null, '\t')}\n`, 'utf8');
	console.log(`Wrote ${listings.length} listings → ${OUT_PATH}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
