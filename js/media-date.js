// 앨범에서 고른 파일이 실제로 찍힌 시각을 알아낸다
// - 사진(JPEG): 사진 안에 저장된 촬영 시각(EXIF DateTimeOriginal)
// - 동영상(MP4/MOV): 파일 안에 저장된 생성 시각(mvhd)
// - 둘 다 없으면 파일 날짜(lastModified)
(function () {
  async function readBytes(blob, start, length) {
    return new DataView(await blob.slice(start, start + length).arrayBuffer());
  }

  function ascii(view, offset, length) {
    let s = '';
    for (let i = 0; i < length && offset + i < view.byteLength; i++) {
      const c = view.getUint8(offset + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  // "2026:10:28 14:32:05" -> 그 휴대폰 시간대 기준 Date
  function parseExifDate(s) {
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s || '');
    if (!m || m[1] === '0000') return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return isNaN(d) ? null : d.getTime();
  }

  async function jpegTakenAt(blob) {
    const view = await readBytes(blob, 0, Math.min(blob.size, 256 * 1024));
    if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off + 4 <= view.byteLength) {
      if (view.getUint8(off) !== 0xFF) return null;
      const marker = view.getUint8(off + 1);
      const len = view.getUint16(off + 2);
      if (marker === 0xE1 && ascii(view, off + 4, 4) === 'Exif') return exifDate(view, off + 10);
      if (marker === 0xDA) return null; // 사진 데이터 시작: 더 이상 정보 없음
      off += 2 + len;
    }
    return null;
  }

  function exifDate(view, tiff) {
    const little = view.getUint16(tiff) === 0x4949;
    const u16 = (o) => view.getUint16(o, little);
    const u32 = (o) => view.getUint32(o, little);
    const readIfd = (ifdOffset) => {
      const tags = {};
      const base = tiff + ifdOffset;
      if (base + 2 > view.byteLength) return tags;
      const count = u16(base);
      for (let i = 0; i < count; i++) {
        const e = base + 2 + i * 12;
        if (e + 12 > view.byteLength) break;
        tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), value: u32(e + 8) };
      }
      return tags;
    };
    const str = (t) => (t && t.type === 2 ? ascii(view, tiff + t.value, t.count) : '');
    const ifd0 = readIfd(u32(tiff + 4));
    const exif = ifd0[0x8769] ? readIfd(ifd0[0x8769].value) : {};
    return parseExifDate(str(exif[0x9003])) || parseExifDate(str(exif[0x9004])) || parseExifDate(str(ifd0[0x0132]));
  }

  async function mp4TakenAt(blob) {
    let off = 0;
    for (let n = 0; n < 64 && off + 8 <= blob.size; n++) {
      const h = await readBytes(blob, off, 16);
      let size = h.getUint32(0);
      const type = ascii(h, 4, 4);
      let header = 8;
      if (size === 1) { size = h.getUint32(8) * 4294967296 + h.getUint32(12); header = 16; }
      else if (size === 0) size = blob.size - off;
      if (size < header) return null;
      if (type === 'moov') {
        const moov = await readBytes(blob, off + header, Math.min(size - header, 4 * 1024 * 1024));
        for (let i = 0; i + 8 < moov.byteLength; i++) {
          if (ascii(moov, i + 4, 4) !== 'mvhd') continue;
          const v = i + 8;
          const secs = moov.getUint8(v) === 1
            ? moov.getUint32(v + 4) * 4294967296 + moov.getUint32(v + 8)
            : moov.getUint32(v + 4);
          if (!secs) return null;
          const ms = (secs - 2082844800) * 1000; // 1904년 기준 초 -> 1970년 기준 밀리초 (UTC)
          return ms > 946684800000 ? ms : null; // 2000년 이전 값은 믿지 않는다
        }
        return null;
      }
      off += size;
    }
    return null;
  }

  async function takenAt(file) {
    try {
      if (/^image\/jpe?g$/.test(file.type)) {
        const t = await jpegTakenAt(file);
        if (t) return t;
      } else if (/^video\/(mp4|quicktime)/.test(file.type) || /\.(mp4|mov)$/i.test(file.name || '')) {
        const t = await mp4TakenAt(file);
        if (t) return t;
      }
    } catch (e) { /* 읽지 못하면 파일 날짜를 쓴다 */ }
    return file.lastModified || Date.now();
  }

  window.MediaDate = { takenAt };
})();
