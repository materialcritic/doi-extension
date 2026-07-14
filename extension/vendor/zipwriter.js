// Minimal, zero-dependency ZIP writer — STORE method only, no compression.
// Written for this extension's "Export Everything" backup feature (settings/
// options.js): the files involved are small text (settings JSON, logs), so
// skipping DEFLATE entirely keeps this vendor file tiny and simple while
// still producing a fully standard, valid .zip any archive tool can open.
// Runs fully offline, no network/CDN dependency — same reasoning as
// vendor/qrcode.js, though this one's an original minimal implementation
// rather than a port of an existing library.
var ZipWriter = (function () {
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(date) {
    var time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    var day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time: time & 0xFFFF, date: day & 0xFFFF };
  }

  function writeUint16(arr, offset, value) {
    arr[offset] = value & 0xFF;
    arr[offset + 1] = (value >>> 8) & 0xFF;
  }

  function writeUint32(arr, offset, value) {
    arr[offset] = value & 0xFF;
    arr[offset + 1] = (value >>> 8) & 0xFF;
    arr[offset + 2] = (value >>> 16) & 0xFF;
    arr[offset + 3] = (value >>> 24) & 0xFF;
  }

  // files: [{ name: string, content: string }] — builds a complete .zip
  // (local file headers + data, central directory, end-of-central-directory
  // record) and returns it as a single Uint8Array.
  function build(files) {
    var encoder = new TextEncoder();
    var dt = dosDateTime(new Date());
    var localParts = [];
    var centralParts = [];
    var offset = 0;

    files.forEach(function (file) {
      var nameBytes = encoder.encode(file.name);
      var dataBytes = encoder.encode(file.content);
      var crc = crc32(dataBytes);

      var localHeader = new Uint8Array(30 + nameBytes.length);
      writeUint32(localHeader, 0, 0x04034b50); // local file header signature
      writeUint16(localHeader, 4, 20); // version needed to extract
      writeUint16(localHeader, 6, 0); // general purpose bit flag
      writeUint16(localHeader, 8, 0); // compression method: 0 = store
      writeUint16(localHeader, 10, dt.time);
      writeUint16(localHeader, 12, dt.date);
      writeUint32(localHeader, 14, crc);
      writeUint32(localHeader, 18, dataBytes.length); // compressed size
      writeUint32(localHeader, 22, dataBytes.length); // uncompressed size
      writeUint16(localHeader, 26, nameBytes.length);
      writeUint16(localHeader, 28, 0); // extra field length
      localHeader.set(nameBytes, 30);

      localParts.push(localHeader, dataBytes);

      var centralHeader = new Uint8Array(46 + nameBytes.length);
      writeUint32(centralHeader, 0, 0x02014b50); // central directory header signature
      writeUint16(centralHeader, 4, 20); // version made by
      writeUint16(centralHeader, 6, 20); // version needed to extract
      writeUint16(centralHeader, 8, 0); // general purpose bit flag
      writeUint16(centralHeader, 10, 0); // compression method
      writeUint16(centralHeader, 12, dt.time);
      writeUint16(centralHeader, 14, dt.date);
      writeUint32(centralHeader, 16, crc);
      writeUint32(centralHeader, 20, dataBytes.length);
      writeUint32(centralHeader, 24, dataBytes.length);
      writeUint16(centralHeader, 28, nameBytes.length);
      writeUint16(centralHeader, 30, 0); // extra field length
      writeUint16(centralHeader, 32, 0); // file comment length
      writeUint16(centralHeader, 34, 0); // disk number start
      writeUint16(centralHeader, 36, 0); // internal file attributes
      writeUint32(centralHeader, 38, 0); // external file attributes
      writeUint32(centralHeader, 42, offset); // relative offset of local header
      centralHeader.set(nameBytes, 46);

      centralParts.push(centralHeader);

      offset += localHeader.length + dataBytes.length;
    });

    var centralOffset = offset;
    var centralSize = centralParts.reduce(function (sum, p) { return sum + p.length; }, 0);

    var eocd = new Uint8Array(22);
    writeUint32(eocd, 0, 0x06054b50); // end of central directory signature
    writeUint16(eocd, 4, 0); // number of this disk
    writeUint16(eocd, 6, 0); // disk where central directory starts
    writeUint16(eocd, 8, files.length); // central directory records on this disk
    writeUint16(eocd, 10, files.length); // total central directory records
    writeUint32(eocd, 12, centralSize);
    writeUint32(eocd, 16, centralOffset);
    writeUint16(eocd, 20, 0); // comment length

    var allParts = localParts.concat(centralParts, [eocd]);
    var totalSize = allParts.reduce(function (sum, p) { return sum + p.length; }, 0);
    var result = new Uint8Array(totalSize);
    var pos = 0;
    allParts.forEach(function (part) {
      result.set(part, pos);
      pos += part.length;
    });
    return result;
  }

  return { build: build };
})();
