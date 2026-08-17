/** Snapshot of rental listings for the /rentals page (updated manually). */

export type RentalSource = 'suumo' | 'yahoo';

export interface RentalListing {
	id: string;
	source: RentalSource;
	title: string;
	address: string;
	station: string;
	walkMinutes: number | null;
	layout: string;
	areaSqm: number | null;
	rentLabel: string;
	managementFeeLabel: string;
	buildingAgeLabel: string;
	builtYear: number | null;
	floorLabel: string;
	url: string;
	city: string;
	parking: boolean;
	independentWashbasin: boolean;
}

export interface RentalsCriteria {
	destination: string;
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
