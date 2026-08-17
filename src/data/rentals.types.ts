/** Snapshot of rental listings for the /rentals page (updated manually). */

export type RentalSource = 'suumo' | 'yahoo';

export interface RentalListing {
	id: string;
	source: RentalSource;
	title: string;
	address: string;
	station: string;
	/** Nearest station name when parseable */
	stationName: string;
	walkMinutes: number | null;
	/** Driving minutes to criteria.destination (OSRM estimate) */
	carMinutes: number | null;
	layout: string;
	areaSqm: number | null;
	rentLabel: string;
	/** Monthly rent in yen (numeric for filters) */
	rentYen: number | null;
	managementFeeLabel: string;
	buildingAgeLabel: string;
	builtYear: number | null;
	/** Building age in years when known */
	ageYears: number | null;
	floorLabel: string;
	url: string;
	city: string;
	parking: boolean;
	independentWashbasin: boolean;
	/** Display label, e.g. 鉄筋コンクリート / 軽量鉄骨 / 鉄筋系 */
	structure: string;
	/** 鉄筋系 | 鉄骨系 | 木造 | その他 */
	structureGroup: string;
	lat: number | null;
	lon: number | null;
}

export interface RentalsCriteria {
	destination: string;
	destinationLat: number;
	destinationLon: number;
	maxCarMinutes: number;
	maxWalkMinutes: number;
	layouts: string[];
	minBuiltYear: number;
	requireParking: boolean;
	requireIndependentWashbasin: boolean;
	commuteAreaNote: string;
	cities: { code: string; name: string }[];
}

export interface RentalsSnapshot {
	updatedAt: string;
	criteria: RentalsCriteria;
	listings: RentalListing[];
	notes: string[];
}
