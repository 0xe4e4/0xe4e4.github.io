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

const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 〒273-0017 千葉県船橋市西浦１丁目１−１ (GSI AddressSearch) */
const DESTINATION = {
	label: '〒273-0017 千葉県船橋市西浦１丁目１−１',
	lat: 35.692646,
	lon: 139.966736,
};

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

const args = process.argv.slice(2);
const enrichOnly = args.includes('--enrich-only');
const maxPages = Number(
	args.find((a) => a.startsWith('--pages='))?.split('=')[1] ?? 2,
);
const delayMs = Number(
	args.find((a) => a.startsWith('--delay='))?.split('=')[1] ?? 1800,
);
const sourcesArg =
	args.find((a) => a.startsWith('--sources='))?.split('=')[1] ?? 'suumo,yahoo';
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
	3: { structure: '木造', structureGroup: '木造' },
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
		lat: partial.lat ?? null,
		lon: partial.lon ?? null,
	};
}

function passesFilters(listing) {
	if (!ALLOWED_LAYOUTS.has(listing.layout)) return false;
	if (listing.walkMinutes != null && listing.walkMinutes > MAX_WALK)
		return false;
	if (listing.builtYear != null && listing.builtYear < MIN_BUILT_YEAR)
		return false;
	if (!listing.parking) return false;
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
	params.set('po1', '25');
	params.set('pc', '50');
	for (const md of ['02', '03', '04', '05', '06']) params.append('md', md);
	params.append('tc', '0400901');
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
				parking: true,
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
	for (const n of [2, 3, 4, 5, 6]) params.append('rl_dtl', String(n));
	params.append('po', 'cr');
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
	2: '1K',
	3: '1DK',
	4: '1LDK',
	5: '2K',
	6: '2DK',
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
				parking: true,
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
	if (!key) return null;
	if (cache[key]) return cache[key];

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
			return null;
		}
		const hit = { lon: coords[0], lat: coords[1] };
		cache[key] = hit;
		return hit;
	} catch (err) {
		console.warn(`  geocode failed: ${address} (${err.message})`);
		cache[key] = null;
		return null;
	}
}

async function fillCoordinates(listings) {
	const cache = loadGeoCache();
	let lookups = 0;
	for (const item of listings) {
		if (item.lat != null && item.lon != null) continue;
		const hit = await geocodeAddress(item.address, cache);
		lookups += 1;
		if (hit) {
			item.lat = hit.lat;
			item.lon = hit.lon;
		}
		if (lookups % 20 === 0) {
			saveGeoCache(cache);
			console.log(`  geocoded ${lookups} addresses…`);
		}
		await sleep(120);
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
			layouts: [...ALLOWED_LAYOUTS],
			minBuiltYear: MIN_BUILT_YEAR,
			requireParking: true,
			requireIndependentWashbasin: true,
			commuteAreaNote:
				'車通勤分は OSRM（一般道想定）の概算。渋滞・有料道路利用は含まない。駅徒歩は掲載の最寄駅徒歩。',
			cities: CITIES.map(({ code, name }) => ({ code, name })),
		},
		listings,
		notes: [
			'この JSON は GitHub Actions（1日3回: 9時・14時・20時 JST）または npm run update:rentals で更新する。ビルド時には取得しない。',
			'SUUMO: 駐車場あり + 洗面所独立。構造は鉄筋系/鉄骨系/木造/その他の系統のみ。',
			'Yahoo!不動産: 駐車場(近隣含む) + 洗面台（洗面所独立の近似）。構造は詳細種別。',
			'車通勤時間は国土地理院ジオコード + OSRM の概算。最新の空室・条件は必ず元ページで確認すること。',
		],
	};
}

async function main() {
	let listings;
	if (enrichOnly) {
		console.log('Enrich-only: reading existing rentals.json…');
		const existing = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
		listings = existing.listings.map(normalizeExistingListing);
	} else {
		console.log(
			`Updating rentals (pages≤${maxPages}, delay=${delayMs}ms, sources=${[...enabledSources]})`,
		);
		const collected = [];
		if (enabledSources.has('suumo')) collected.push(...(await fetchSuumo()));
		if (enabledSources.has('yahoo')) collected.push(...(await fetchYahoo()));
		listings = dedupe(collected);
	}

	await fillCoordinates(listings);
	await fillCarMinutes(listings);
	listings = dedupe(listings);

	const snapshot = buildSnapshot(listings);
	writeFileSync(OUT_PATH, `${JSON.stringify(snapshot, null, '\t')}\n`, 'utf8');
	console.log(`Wrote ${listings.length} listings → ${OUT_PATH}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
