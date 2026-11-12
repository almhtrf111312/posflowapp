import { getDefaultFieldsByStoreType } from '../product-fields-config';

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
  console.log(`PASS ${message}`);
}

const clothing = getDefaultFieldsByStoreType('clothing');
eq(clothing.sizeColor, true, 'clothing: size & color on');
eq(clothing.fabricType, true, 'clothing: fabric on');
eq(clothing.serialNumber, false, 'clothing: serial off');
eq(clothing.imei, false, 'clothing: IMEI off');
eq(clothing.expiryDate, false, 'clothing: expiry off');

const phones = getDefaultFieldsByStoreType('phones');
eq(phones.serialNumber, true, 'phones: serial on');
eq(phones.imei, true, 'phones: IMEI on (separate field)');
eq(phones.warranty, true, 'phones: warranty on');
eq(phones.sizeColor, false, 'phones: size/color off');

const grocery = getDefaultFieldsByStoreType('grocery');
eq(grocery.expiryDate, true, 'grocery: expiry on');
eq(grocery.weight, true, 'grocery: weight on');
eq(grocery.imei, false, 'grocery: IMEI off');

const pharmacy = getDefaultFieldsByStoreType('pharmacy');
eq(pharmacy.expiryDate && pharmacy.batchNumber, true, 'pharmacy: expiry + batch on');

eq(getDefaultFieldsByStoreType('bakery').expiryDate, true, 'bakery: expiry on');
const books = getDefaultFieldsByStoreType('bookstore');
eq(books.author && books.publisher && books.serialNumber, true, 'bookstore: author, publisher, ISBN on');
eq(getDefaultFieldsByStoreType('restaurant').tableNumber, true, 'restaurant: table number on');
const general = getDefaultFieldsByStoreType('general');
eq(Object.values(general).some(Boolean), false, 'general: nothing special on');
