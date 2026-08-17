#!/usr/bin/env node
/**
 * Manual updater for src/data/rentals.json
 *
 * Run explicitly when you want a fresh snapshot:
 *   npm run update:rentals
 *
 * Not hooked into build/CI. Requests are delayed and page-capped so
 * SUUMO / Yahoo Real Estate are not hammered.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '../src/data/rentals.json');

const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** Approx. car-commute area around 船橋市西浦1-1-1 (≤ ~20 min). */
const CITIES = [
	{ code: '12204', name: '船橋市', suumoSlug: 'sc_funabashi' },
	{ code: '12216', name: '習志野市', suumoSlug: 'sc_narashino' },
	{ code: '12203', name: '市川市', suumoSlug: 'sc_ichikawa' },
	{ code: '12106', name: '千葉市美浜区', suumoSlug: 'sc_chibashimihama' },
	{ code: '12227', name: '浦安市', suumoSlug: 'sc_urayasu' },
];

const ALLOWED_LAYOUTS = new Set(['1K', '1DK', '1LDK', '2K', '2DK']);
const MIN_BUILT_YEAR = 1981;
const MAX_WALK = 15;

/** Default: few pages per city × source. Override with --pages=N */
const args = process.argv.slice(2);
const maxPages = Number(args.find((a) => a.startsWith('--pages='))?.split('=')[1] ?? 2);
const delayMs = Number(args.find((a) => a.startsWith('--delay='))?.split('=')[1] ?? 1800);
const sourcesArg = args.find((a) => a.startsWith('--sources='))?.split('=')[1] ?? 'suumo,yahoo';
const enabledSources = new Set(sourcesArg.split(',').map((s) => s.trim()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, referer) {
	const res = await fetch(url, {
		headers: {
			'User-Agent': UA,
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
			...(referer ? { Referer: referer } : {}),
		},
		redirect: 'follow',
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return res.text();
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
	const m = text.match(/歩\s*(\d+)\s*分|徒歩\s*(\d+)\s*分|(\d+)\s*分以内/);
	if (!m) return null;
	return Number(m[1] || m[2] || m[3]);
}

function parseBuiltYear(ageLabel, nowYear = new Date().getFullYear()) {
	if (/新築/.test(ageLabel)) return nowYear;
	const age = ageLabel.match(/築\s*(\d+)\s*年/);
	if (age) return nowYear - Number(age[1]);
	const y = ageLabel.match(/(19|20)\d{2}/);
	return y ? Number(y[0]) : null;
}

function normalizeLayout(raw) {
	const t = raw.replace(/\s+/g, '').toUpperCase();
	const m = t.match(/(\d)\s*(S?L?D?K|R)/);
	if (!m) return t;
	const n = m[1];
	const kind = m[2].replace(/^S/, ''); // ignore service room prefix loosely
	if (kind === 'R') return 'ワンルーム';
	return `${n}${kind}`;
}

function parseArea(raw) {
	const m = String(raw).replace(/,/g, '').match(/([\d.]+)\s*m/i);
	return m ? Number(m[1]) : null;
}

function cityFromAddress(address, fallback) {
	for (const c of CITIES) {
		if (address.includes(c.name)) return c.name;
	}
	return fallback;
}

function passesFilters(listing) {
	if (!ALLOWED_LAYOUTS.has(listing.layout)) return false;
	if (listing.walkMinutes != null && listing.walkMinutes > MAX_WALK) return false;
	if (listing.builtYear != null && listing.builtYear < MIN_BUILT_YEAR) return false;
	if (!listing.parking) return false;
	if (!listing.independentWashbasin) return false;
	const cityNames = CITIES.map((c) => c.name);
	if (listing.address && !cityNames.some((name) => listing.address.includes(name))) return false;
	return true;
}

/** ---- SUUMO ---- */

function buildSuumoUrl(cityCode, page) {
	const params = new URLSearchParams();
	params.set('ar', '030');
	params.set('bs', '040');
	params.set('ta', '12');
	params.set('sc', cityCode);
	params.set('et', String(MAX_WALK));
	params.set('po1', '25');
	params.set('pc', '50');
	// 1K / 1DK / 1LDK / 2K / 2DK
	for (const md of ['02', '03', '04', '05', '06']) params.append('md', md);
	// 駐車場あり / 洗面所独立
	params.append('tc', '0400901');
	params.append('tc', '0400502');
	if (page > 1) params.set('page', String(page));
	return `https://suumo.jp/jj/chintai/ichiran/FR301FC001/?${params.toString()}`;
}

function parseSuumo(html, city) {
	const listings = [];
	if (/エラー｜SUUMO/.test(html)) {
		console.warn(`  SUUMO error page for ${city.name}`);
		return listings;
	}

	const blocks = html.split(/<div class="cassetteitem">/).slice(1);
	for (const block of blocks) {
		const title = stripTags(
			(block.match(/cassetteitem_content-title[^>]*>([\s\S]*?)<\//) || [])[1] || '',
		);
		const address = stripTags(
			(block.match(/cassetteitem_detail-col1[^>]*>([\s\S]*?)<\//) || [])[1] || '',
		);
		const stationRaw = stripTags(
			(block.match(/cassetteitem_detail-col2[\s\S]*?cassetteitem_detail-text[^>]*>([\s\S]*?)<\//) ||
				[])[1] || '',
		);
		const ageRaw = stripTags(
			(block.match(/cassetteitem_detail-col3[\s\S]*?<div>([\s\S]*?)<\/div>/) || [])[1] || '',
		);
		const walkMinutes = parseWalkMinutes(stationRaw);
		const builtYear = parseBuiltYear(ageRaw);

		const rows = block.match(/<tbody>([\s\S]*?)<\/tbody>/g) || [];
		for (const row of rows) {
			const tds = [...row.matchAll(/<td[\s\S]*?>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
			if (tds.length < 9) continue;

			const floorLabel = stripTags(tds[2] || '');
			const rentLabel = stripTags(
				(tds[3].match(/cassetteitem_price--rent[^>]*>([\s\S]*?)<\//) || [])[1] || tds[3],
			);
			const managementFeeLabel = stripTags(
				(tds[3].match(/cassetteitem_price--administration[^>]*>([\s\S]*?)<\//) || [])[1] ||
					'',
			);
			const layout = normalizeLayout(
				stripTags((tds[5].match(/cassetteitem_madori[^>]*>([\s\S]*?)<\//) || [])[1] || tds[5]),
			);
			const areaSqm = parseArea(
				stripTags((tds[5].match(/cassetteitem_menseki[^>]*>([\s\S]*?)<\//) || [])[1] || ''),
			);
			const href =
				(row.match(/href="(\/chintai\/jnc_[^"]+)"/) ||
					row.match(/href="(https:\/\/suumo\.jp\/chintai\/jnc_[^"]+)"/) ||
					[])[1] || '';
			if (!href) continue;
			const url = href.startsWith('http') ? href : `https://suumo.jp${href}`;
			const idMatch = url.match(/bc=(\d+)/) || url.match(/jnc_(\d+)/);
			const id = `suumo:${idMatch?.[1] || url}`;

			const listing = {
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
				parking: true,
				independentWashbasin: true,
			};
			if (passesFilters(listing)) listings.push(listing);
		}
	}
	return listings;
}

async function fetchSuumo() {
	const out = [];
	for (const city of CITIES) {
		console.log(`SUUMO ${city.name}…`);
		for (let page = 1; page <= maxPages; page++) {
			const url = buildSuumoUrl(city.code, page);
			try {
				const html = await fetchText(
					url,
					`https://suumo.jp/chintai/chiba/${city.suumoSlug}/`,
				);
				const items = parseSuumo(html, city);
				console.log(`  page ${page}: ${items.length} matching rooms`);
				out.push(...items);
				if (!/cassetteitem/.test(html)) break;
				const next = html.includes(`page=${page + 1}`) || html.includes(`page=${page + 1}&`);
				if (!next && page > 1) break;
			} catch (err) {
				console.warn(`  failed page ${page}:`, err.message);
				break;
			}
			await sleep(delayMs);
		}
	}
	return out;
}

/** ---- Yahoo Real Estate ---- */

function buildYahooUrl(cityCode, page) {
	const params = new URLSearchParams();
	params.set('min_st', String(MAX_WALK));
	// 1K–2DK detail room layouts
	for (const n of [2, 3, 4, 5, 6]) params.append('rl_dtl', String(n));
	params.append('po', 'cr'); // 駐車場(近隣含む)
	params.append('po', 'ws'); // 洗面台（Yahoo側に「洗面所独立」は無し）
	if (page > 1) params.set('page', String(page));
	return `https://realestate.yahoo.co.jp/rent/search/03/12/${cityCode}/?${params.toString()}`;
}

function extractYahooContext(html) {
	const m = html.match(/window\.__SERVER_SIDE_CONTEXT__\s*=\s*(\{[\s\S]*?\});\s*\/\*\]\]>/);
	if (!m) return null;
	// Trusted snapshot from Yahoo's own page; eval is required because keys are unquoted JS.
	return Function(`"use strict"; return (${m[1]});`)();
}

const YAHOO_LAYOUT = {
	2: '1K',
	3: '1DK',
	4: '1LDK',
	5: '2K',
	6: '2DK',
};

function parseYahoo(html, city) {
	const ctx = extractYahooContext(html);
	if (!ctx?.page?.properties) {
		console.warn(`  Yahoo: no SERVER_SIDE_CONTEXT for ${city.name}`);
		return { listings: [], lastPage: 1 };
	}
	const lastPage = ctx.page.paginationContext?.lastPage ?? 1;
	const listings = [];

	for (const building of ctx.page.properties) {
		const address = building.LocationView?.AddressName || '';
		const transports = building.Transports || [];
		const nearest = transports
			.filter((t) => t.MinutesFromStation != null)
			.sort((a, b) => a.MinutesFromStation - b.MinutesFromStation)[0];
		const station = nearest?.Label || transports[0]?.Label || '';
		const walkMinutes = nearest?.MinutesFromStation ?? parseWalkMinutes(station);
		const builtOn = building.BuiltOn || '';
		const builtYear = builtOn ? Number(String(builtOn).slice(0, 4)) : null;
		const ageLabel =
			building.YearsOld != null ? `築${building.YearsOld}年` : builtOn || '';

		for (const room of building.GroupProperties || []) {
			const layout = YAHOO_LAYOUT[room.DetailRoomLayout] || String(room.DetailRoomLayout || '');
			const id = `yahoo:${room.PropertyId}`;
			const url = `https://realestate.yahoo.co.jp/rent/detail/${room.PropertyId}/`;
			const floorNum = room.FloorNum != null && room.FloorNum !== '' ? `${room.FloorNum}階` : '';

			const listing = {
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
				// Search URL already applies po=cr / po=ws (洗面台 ≈ 洗面独立の近似)
				parking: true,
				independentWashbasin: true,
			};
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
				const html = await fetchText(url, 'https://realestate.yahoo.co.jp/rent/');
				const { listings, lastPage: lp } = parseYahoo(html, city);
				lastPage = lp;
				console.log(`  page ${page}/${lastPage}: ${listings.length} matching rooms`);
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
		const ra = parseFloat(String(a.rentLabel).replace(/[^\d.]/g, '')) || 0;
		const rb = parseFloat(String(b.rentLabel).replace(/[^\d.]/g, '')) || 0;
		return ra - rb;
	});
}

async function main() {
	console.log(
		`Updating rentals (pages≤${maxPages}, delay=${delayMs}ms, sources=${[...enabledSources]})`,
	);
	const collected = [];
	if (enabledSources.has('suumo')) collected.push(...(await fetchSuumo()));
	if (enabledSources.has('yahoo')) collected.push(...(await fetchYahoo()));

	const listings = dedupe(collected);
	const snapshot = {
		updatedAt: new Date().toISOString(),
		criteria: {
			destination: '〒273-0017 千葉県船橋市西浦１丁目１−１',
			maxCarMinutes: 20,
			maxWalkMinutes: MAX_WALK,
			layouts: [...ALLOWED_LAYOUTS],
			minBuiltYear: MIN_BUILT_YEAR,
			requireParking: true,
			requireIndependentWashbasin: true,
			commuteAreaNote:
				'車20分圏は目安として船橋・習志野・市川・千葉市美浜区・浦安を対象。個別の所要時間は地図で要確認。',
			cities: CITIES.map(({ code, name }) => ({ code, name })),
		},
		listings,
		notes: [
			'この JSON は npm run update:rentals で手動更新する。ビルドや CI では取得しない。',
			'SUUMO: 駐車場あり + 洗面所独立 で検索。',
			'Yahoo!不動産: 駐車場(近隣含む) + 洗面台 で検索（洗面所独立の同等条件が無いため近似）。',
			'掲載は各サイトの公開情報のスナップショット。最新の空室・条件は必ず元ページで確認すること。',
		],
	};

	writeFileSync(OUT_PATH, `${JSON.stringify(snapshot, null, '\t')}\n`, 'utf8');
	console.log(`Wrote ${listings.length} listings → ${OUT_PATH}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
