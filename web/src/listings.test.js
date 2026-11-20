import { describe, expect, it } from 'vitest';
import { DEFAULT_AD, bedsLabel, buildingState, formatAED, listingProblems, listingState, listingsCsv, metresBetween, nearAll, nearestArea, nearestPoi, parseAmount, readListingLink, shortAED } from './listings.js';

const crit = (c = {}) => ({ ...structuredClone(DEFAULT_AD), ...c });
const L = (o = {}) => ({ rent: 90000, beds: 2, sqft: 1200, lng: 54.4, lat: 24.49, area: 'Al Reem Island', near: { mall: { m: 800 }, beach: { m: 3000 }, school: { m: 600 } }, ...o });

describe('money and words', () => {
  it('formats AED exactly and in short form', () => {
    expect(formatAED(85500)).toBe('AED 85,500');
    expect(shortAED(85500)).toBe('AED 85.5k');
    expect(shortAED(1200000)).toBe('AED 1.2M');
    expect(formatAED(null)).toBe('');
  });
  it('reads typed amounts', () => {
    expect(parseAmount('85,000')).toBe(85000);
    expect(parseAmount('AED 95000')).toBe(95000);
    expect(parseAmount('85k')).toBe(85000);
    expect(parseAmount('about 80')).toBeNull();
  });
  it('says studio and bedrooms, not BHK', () => {
    expect(bedsLabel(0)).toBe('Studio');
    expect(bedsLabel(1)).toBe('1 bedroom');
    expect(bedsLabel(3)).toBe('3 bedrooms');
  });
});

describe('pasted links', () => {
  const areas = ['Al Reem Island', 'Reem', 'Yas Island', 'Khalifa City'];
  it('knows the site and finds an area named in the link', () => {
    const r = readListingLink('https://www.propertyfinder.ae/en/plp/rent/apartment-for-rent-abu-dhabi-al-reem-island-the-gate-tower-2-123.html', areas);
    expect(r).toMatchObject({ ok: true, site: 'Property Finder', area: 'Al Reem Island' });
    expect(readListingLink('https://www.bayut.com/property/details-9876.html', areas)).toMatchObject({ ok: true, site: 'Bayut', area: null });
  });
  it('rejects things that are not web links', () => {
    expect(readListingLink('javascript:alert(1)').ok).toBe(false);
    expect(readListingLink('not a link').ok).toBe(false);
    expect(readListingLink('https://example.com/x').site).toBeNull();
  });
});

describe('checking a listing', () => {
  it('accepts a complete listing and explains problems in plain words', () => {
    expect(listingProblems(L())).toEqual([]);
    expect(listingProblems(L({ sqft: null, url: '' }))).toEqual([]);
    expect(listingProblems(L({ rent: 7500 }))[0]).toMatch(/monthly/); // a monthly number typed by mistake
    expect(listingProblems(L({ rent: 12000 }))).toEqual([]);
    expect(listingProblems(L({ beds: 5, lng: NaN }))).toHaveLength(2);
  });
});

describe('filters', () => {
  it('matches on bedrooms, yearly rent, size and distances', () => {
    expect(listingState(L(), crit())).toBe('match');
    expect(listingState(L(), crit({ beds: [0, 1] }))).toBe('no');
    expect(listingState(L(), crit({ maxRent: 80000 }))).toBe('no');
    expect(listingState(L(), crit({ minSqft: 1300 }))).toBe('no');
    expect(listingState(L({ sqft: null }), crit({ minSqft: 1000 }))).toBe('unknown');
    expect(listingState(L(), crit({ near: ['mall', 'school'] }))).toBe('match');
    expect(listingState(L(), crit({ near: ['beach'] }))).toBe('no');
    expect(listingState(L(), crit({ area: 'Yas Island' }))).toBe('no');
  });
  it('lights a building by its listings, else leaves it unchecked', () => {
    const b = { id: 'w1', area: 'Al Reem Island', near: { mall: { m: 500 } } };
    expect(buildingState(b, [L()], crit())).toBe('match');
    expect(buildingState(b, [L({ sqft: null })], crit({ minSqft: 900 }))).toBe('likely');
    expect(buildingState(b, [], crit())).toBe('unknown');
    expect(buildingState(b, [], crit({ near: ['beach'] }))).toBe('no');
  });
});

describe('distances', () => {
  const pois = [
    { k: 'mall', name: 'M', lng: 54.40, lat: 24.40 },
    { k: 'beach', name: 'Strip', lines: [[[54.30, 24.41], [54.50, 24.41]]] },
  ];
  it('measures to the nearest edge of a long beach, not its corners', () => {
    const b = nearestPoi([54.40, 24.40], pois, 'beach');
    expect(b.m).toBeGreaterThan(1000);
    expect(b.m).toBeLessThan(1200); // 0.01 degree north is about 1.1 km
    expect(nearestPoi([54.40, 24.40], pois, 'school')).toBeNull();
    expect(nearAll([54.40, 24.40], pois).mall.m).toBe(0);
  });
  it('finds the closest named area within reach', () => {
    const areas = [{ name: 'A', lng: 54.40, lat: 24.40 }, { name: 'B', lng: 54.45, lat: 24.40 }];
    expect(nearestArea([54.44, 24.40], areas)).toBe('B');
    expect(nearestArea([55, 25], areas)).toBeNull();
    expect(Math.round(metresBetween([54, 24], [54, 24.01]))).toBe(1112);
  });
});

it('exports listings as CSV with yearly AED rent', () => {
  const csv = listingsCsv([{ ...L(), beds: 0, note: 'has "pool", gym', site: 'Bayut', url: 'https://www.bayut.com/x' }]);
  expect(csv.split('\n')[0]).toContain('rent_aed_per_year,bedrooms');
  expect(csv).toContain(',studio,');
  expect(csv).toContain('"has ""pool"", gym"');
});
