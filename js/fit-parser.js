/*
 * fit-parser.js — Lecteur binaire minimal du format Garmin FIT (Flexible and Interoperable Data Transfer).
 * Ne dépend d'aucune librairie externe. Extrait uniquement ce dont l'app a besoin : les messages
 * "record" (position GPS, altitude, timestamp) d'une activité.
 *
 * Référence du format : FIT SDK (Garmin), messages de définition / données, en-tête normal ou
 * compressé (timestamp compressé sur 5 bits).
 */

const FIT_EPOCH_OFFSET_S = 631065600; // secondes entre 1989-12-31T00:00:00Z et 1970-01-01T00:00:00Z (epoch Unix)

// Table des types de base FIT : { taille en octets, "invalide" (valeur sentinelle) }
const FIT_BASE_TYPES = {
  0x00: { size: 1, invalid: 0xFF, kind: 'uint' },   // enum
  0x01: { size: 1, invalid: 0x7F, kind: 'sint' },   // sint8
  0x02: { size: 1, invalid: 0xFF, kind: 'uint' },   // uint8
  0x83: { size: 2, invalid: 0x7FFF, kind: 'sint' }, // sint16
  0x84: { size: 2, invalid: 0xFFFF, kind: 'uint' }, // uint16
  0x85: { size: 4, invalid: 0x7FFFFFFF, kind: 'sint' }, // sint32
  0x86: { size: 4, invalid: 0xFFFFFFFF, kind: 'uint' }, // uint32
  0x07: { size: 1, invalid: 0x00, kind: 'string' },
  0x88: { size: 4, invalid: 0xFFFFFFFF, kind: 'float' },
  0x89: { size: 8, invalid: 0xFFFFFFFFFFFF, kind: 'double' },
  0x0A: { size: 1, invalid: 0x00, kind: 'uint' },   // uint8z
  0x8B: { size: 2, invalid: 0x0000, kind: 'uint' }, // uint16z
  0x8C: { size: 4, invalid: 0x00000000, kind: 'uint' }, // uint32z
  0x0D: { size: 1, invalid: 0xFF, kind: 'byte' },
  0x8E: { size: 8, invalid: null, kind: 'sint64' },
  0x8F: { size: 8, invalid: null, kind: 'uint64' },
  0x90: { size: 8, invalid: null, kind: 'uint64' },
};

const GLOBAL_MSG_RECORD = 20;
const GLOBAL_MSG_FILE_ID = 0;

const FIELD_RECORD_TIMESTAMP = 253;
const FIELD_RECORD_LAT = 0;
const FIELD_RECORD_LON = 1;
const FIELD_RECORD_ALTITUDE = 2;
const FIELD_RECORD_ENHANCED_ALTITUDE = 78;
const FIELD_FILEID_TIME_CREATED = 4;

function semicirclesToDegrees(v) {
  return v * (180 / Math.pow(2, 31));
}

class FitReader {
  constructor(arrayBuffer) {
    this.view = new DataView(arrayBuffer);
    this.byteLength = arrayBuffer.byteLength;
    this.offset = 0;
  }

  readUint8() { const v = this.view.getUint8(this.offset); this.offset += 1; return v; }

  readBytes(n) {
    const arr = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, n);
    this.offset += n;
    return arr;
  }

  readField(size, baseTypeByte, littleEndian) {
    const info = FIT_BASE_TYPES[baseTypeByte] || { size, invalid: null, kind: 'uint' };
    // Champ tableau / chaîne / taille non standard : on lit tel quel et on ignore la valeur.
    if (info.kind === 'string' || info.kind === 'byte' || size !== info.size) {
      const bytes = this.readBytes(size);
      return { raw: bytes, value: null };
    }
    let value = null;
    if (size === 1) {
      const b = this.readUint8();
      value = (info.kind === 'sint' && b > 0x7F) ? b - 0x100 : b;
      if (b === info.invalid) value = null;
    } else if (size === 2) {
      const b = this.readBytes(2);
      const raw = littleEndian ? (b[0] | (b[1] << 8)) : ((b[0] << 8) | b[1]);
      value = (info.kind === 'sint' && raw > 0x7FFF) ? raw - 0x10000 : raw;
      if (raw === (info.invalid & 0xFFFF)) value = null;
    } else if (size === 4) {
      const b = this.readBytes(4);
      let raw;
      if (littleEndian) raw = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
      else raw = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
      if (info.kind === 'float') {
        const dv = new DataView(b.buffer, b.byteOffset, 4);
        value = dv.getFloat32(0, littleEndian);
      } else if (info.kind === 'sint') {
        value = raw > 0x7FFFFFFF ? raw - 0x100000000 : raw;
        if ((raw >>> 0) === (info.invalid >>> 0)) value = null;
      } else {
        value = raw;
        if ((raw >>> 0) === (info.invalid >>> 0)) value = null;
      }
    } else {
      // 8 octets (sint64/uint64/double) : au-delà des besoins de l'app, on saute proprement.
      this.readBytes(size);
      value = null;
    }
    return { value };
  }
}

/**
 * Parse un fichier .fit et retourne les points GPS trouvés dans les messages "record".
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{ points: Array<{timestamp: number, lat: number, lon: number, altitude: number|null}>, pointCount: number }}
 */
function parseFitPoints(arrayBuffer) {
  const reader = new FitReader(arrayBuffer);

  if (reader.byteLength < 14) throw new Error('Fichier .fit invalide ou trop court.');
  const headerSize = reader.readUint8();
  reader.offset = 0;
  const header = reader.readBytes(headerSize);
  const magic = String.fromCharCode(header[8], header[9], header[10], header[11]);
  if (magic !== '.FIT') throw new Error("Ce fichier ne semble pas être un fichier .fit valide (signature manquante).");

  const dataSize = (header[4] | (header[5] << 8) | (header[6] << 16) | (header[7] << 24)) >>> 0;
  const dataEnd = Math.min(headerSize + dataSize, reader.byteLength);

  const localDefs = {}; // localType -> { globalMsgNum, littleEndian, fields: [{num,size,baseType}], fieldSet }
  const points = [];
  let referenceTimestamp = null; // dernier timestamp absolu (secondes epoch FIT) rencontré
  let fileIdTimeCreated = null;

  while (reader.offset < dataEnd) {
    // Un fichier légèrement tronqué ou mal formé ne doit pas faire planter toute la conversion :
    // on retourne alors les points déjà lus jusqu'ici plutôt que de propager l'exception.
    let recordHeader;
    try {
      recordHeader = reader.readUint8();
    } catch (e) {
      break;
    }
    // Bit 7 = 1 => en-tête "timestamp compressé" (toujours un message de données, jamais une définition).
    // Bit 7 = 0 => en-tête normal ; bit 6 distingue alors définition (1) / donnée (0).
    const isCompressedTimestamp = (recordHeader & 0x80) !== 0;
    const isDefinition = !isCompressedTimestamp && (recordHeader & 0x40) !== 0;

    let parsedOk = true;
    try {

    if (isDefinition) {
      const localType = recordHeader & 0x0F;
      reader.readUint8(); // reserved
      const architecture = reader.readUint8();
      const littleEndian = architecture === 0;
      const b0 = reader.readUint8();
      const b1 = reader.readUint8();
      const globalMsgNum = littleEndian ? (b0 | (b1 << 8)) : ((b0 << 8) | b1);
      const numFields = reader.readUint8();
      const fields = [];
      for (let i = 0; i < numFields; i++) {
        const fieldNum = reader.readUint8();
        const size = reader.readUint8();
        const baseType = reader.readUint8();
        fields.push({ num: fieldNum, size, baseType });
      }
      let devFields = [];
      const hasDevFields = (recordHeader & 0x20) !== 0;
      if (hasDevFields) {
        const numDev = reader.readUint8();
        for (let i = 0; i < numDev; i++) {
          const fieldNum = reader.readUint8();
          const size = reader.readUint8();
          reader.readUint8(); // developer data index
          devFields.push({ num: fieldNum, size, baseType: 0x0D });
        }
      }
      localDefs[localType] = { globalMsgNum, littleEndian, fields, devFields };
    } else {
      let localType;
      let timeOffset = null;
      if (isCompressedTimestamp) {
        localType = (recordHeader >> 5) & 0x03;
        timeOffset = recordHeader & 0x1F;
      } else {
        localType = recordHeader & 0x0F;
      }
      const def = localDefs[localType];
      if (!def) {
        // Définition inconnue : on ne peut pas savoir combien d'octets lire, on arrête proprement.
        break;
      }

      let msgTimestamp = null;
      let lat = null;
      let lon = null;
      let altitude = null;
      let enhancedAltitude = null;

      const allFields = def.fields.concat(def.devFields || []);
      for (const f of allFields) {
        const { value } = reader.readField(f.size, f.baseType, def.littleEndian);
        if (def.globalMsgNum === GLOBAL_MSG_RECORD) {
          if (f.num === FIELD_RECORD_TIMESTAMP && value !== null) msgTimestamp = value;
          else if (f.num === FIELD_RECORD_LAT && value !== null) lat = semicirclesToDegrees(value);
          else if (f.num === FIELD_RECORD_LON && value !== null) lon = semicirclesToDegrees(value);
          else if (f.num === FIELD_RECORD_ALTITUDE && value !== null) altitude = value / 5 - 500;
          else if (f.num === FIELD_RECORD_ENHANCED_ALTITUDE && value !== null) enhancedAltitude = value / 5 - 500;
        } else if (def.globalMsgNum === GLOBAL_MSG_FILE_ID) {
          if (f.num === FIELD_FILEID_TIME_CREATED && value !== null) fileIdTimeCreated = value;
        }
      }

      if (msgTimestamp !== null) referenceTimestamp = msgTimestamp;

      if (isCompressedTimestamp && timeOffset !== null) {
        const base = referenceTimestamp !== null ? referenceTimestamp : fileIdTimeCreated;
        if (base !== null) {
          const baseOffset = base & 0x1F;
          let ts = (base & 0xFFFFFFE0) + timeOffset;
          if (timeOffset < baseOffset) ts += 32;
          msgTimestamp = ts;
          referenceTimestamp = ts;
        }
      }

      if (def.globalMsgNum === GLOBAL_MSG_RECORD && lat !== null && lon !== null && msgTimestamp !== null) {
        points.push({
          timestamp: msgTimestamp + FIT_EPOCH_OFFSET_S, // secondes epoch Unix
          lat,
          lon,
          altitude: enhancedAltitude !== null ? enhancedAltitude : altitude,
        });
      }
    }

    } catch (e) {
      parsedOk = false;
    }
    if (!parsedOk) break;
  }

  return { points, pointCount: points.length };
}

if (typeof module !== 'undefined') {
  module.exports = { parseFitPoints, FIT_EPOCH_OFFSET_S, semicirclesToDegrees };
}
