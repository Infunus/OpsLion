// Read inert string literals from picture-post data; never execute article scripts.
function quotedValue(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return null;
  let value = '';
  for (let pos = start + 1; pos < source.length; pos++) {
    const char = source[pos];
    if (char === quote) return { value, end: pos + 1 };
    if (char !== '\\') { value += char; continue; }
    const escaped = source[++pos];
    if (escaped === undefined) return null;
    if (escaped === 'x' || escaped === 'u') {
      const count = escaped === 'x' ? 2 : 4;
      const digits = source.slice(pos + 1, pos + count + 1);
      if (digits.length !== count || !/^[\da-f]+$/i.test(digits)) return null;
      value += String.fromCharCode(parseInt(digits, 16));
      pos += count;
    } else if (escaped === '\r' || escaped === '\n') {
      if (escaped === '\r' && source[pos + 1] === '\n') pos++;
    } else {
      value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' })[escaped] ?? escaped;
    }
  }
  return null;
}

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entity[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' })[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function galleryImages(source, start) {
  const stack = [];
  const images = [];
  for (let pos = start; pos < source.length;) {
    const char = source[pos];
    if (char === '/' && source[pos + 1] === '/') {
      const end = source.indexOf('\n', pos + 2);
      if (end < 0) return [];
      pos = end + 1; continue;
    }
    if (char === '/' && source[pos + 1] === '*') {
      const end = source.indexOf('*/', pos + 2);
      if (end < 0) return [];
      pos = end + 2; continue;
    }
    if (char === '"' || char === "'") {
      const literal = quotedValue(source, pos);
      if (!literal) return [];
      pos = literal.end; continue;
    }
    if (char === '[' || char === '{') stack.push(char);
    if (char === ']' || char === '}') {
      if (stack.pop() !== (char === ']' ? '[' : '{')) return [];
      if (!stack.length) return images;
    }
    if (/[a-z_$]/i.test(char)) {
      const identifier = /^[\w$]+/.exec(source.slice(pos))[0];
      pos += identifier.length;
      if (identifier === 'cdn_url' && stack.join('') === '[{') {
        const colon = /^\s*:\s*/.exec(source.slice(pos));
        const literal = colon && quotedValue(source, pos + colon[0].length);
        if (literal) { images.push(decodeEntities(literal.value)); pos = literal.end; }
      }
      continue;
    }
    pos++;
  }
  return [];
}

export function parseGalleryHtml(raw) {
  const scripts = Array.from(raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi), (match) => match[1]);
  const assignment = (pattern) => {
    for (const script of scripts) {
      const match = pattern.exec(script);
      if (match) return quotedValue(script, match.index + match[0].length)?.value;
    }
  };
  if (assignment(/\bwindow\.appmsg_type\s*=\s*/) !== '9') return null;
  const caption = assignment(/\bwindow\.desc\s*=\s*/);
  const title = assignment(/\bwindow\.msg_title\s*=\s*window\.title\s*=\s*/);
  if (caption === undefined || !title) return null;
  const data = scripts.find((script) => /\bwindow\.cgiDataNew\s*=\s*\{/.test(script));
  const list = data && /\bpicture_page_info_list\s*:\s*(?=\[)/.exec(data);
  if (!list) return null;
  const images = [...new Set(galleryImages(data, list.index + list[0].length))];
  if (!images.length || images.some((source) => {
    try { const url = new URL(source); return url.protocol !== 'https:' || url.hostname !== 'mmbiz.qpic.cn' || !!url.username || !!url.password || !!url.port; }
    catch { return true; }
  })) return null;
  const text = decodeEntities(caption).replace(/\r/g, '').trim();
  const html = text.split('\n').map((line) => '<p>' + (escapeHtml(line) || '<br>') + '</p>').join('\n')
    + '\n' + images.map((source) => '<img src="' + escapeHtml(source) + '" alt="">').join('\n');
  return { ok: true, title: decodeEntities(title).trim(), html, text, images, http: 200, source: 'weread', content_kind: 'gallery' };
}

// Read only top-level literal fields without executing article scripts.
function objectStrings(source, start) {
  const values = {};
  const stack = [];
  for (let pos = start; pos < source.length;) {
    const char = source[pos];
    if (char === '/' && source[pos + 1] === '/') {
      const end = source.indexOf('\n', pos + 2);
      if (end < 0) return null;
      pos = end + 1; continue;
    }
    if (char === '/' && source[pos + 1] === '*') {
      const end = source.indexOf('*/', pos + 2);
      if (end < 0) return null;
      pos = end + 2; continue;
    }
    if (char === '"' || char === "'") {
      const literal = quotedValue(source, pos);
      if (!literal) return null;
      pos = literal.end; continue;
    }
    if (char === '[' || char === '{') stack.push(char);
    if (char === ']' || char === '}') {
      if (stack.pop() !== (char === ']' ? '[' : '{')) return null;
      if (!stack.length) return values;
    }
    if (/[a-z_$]/i.test(char)) {
      const identifier = /^[\w$]+/.exec(source.slice(pos))[0];
      pos += identifier.length;
      if (stack.join('') === '{') {
        const colon = /^\s*:\s*/.exec(source.slice(pos));
        const literal = colon && quotedValue(source, pos + colon[0].length);
        if (literal) { values[identifier] = decodeEntities(literal.value); pos = literal.end; }
      }
      continue;
    }
    pos++;
  }
  return null;
}

export function parseVideoHtml(raw) {
  const scripts = Array.from(raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi), (match) => match[1]);
  const script = scripts.find((value) => /\bwindow\.cgiDataNew\s*=\s*\{/.test(value));
  if (!script) return null;
  const dataStart = /\bwindow\.cgiDataNew\s*=\s*(?=\{)/.exec(script);
  const videoStart = /\bvideo_page_info\s*:\s*(?=\{)/.exec(script);
  if (!videoStart) return null;
  const data = objectStrings(script, dataStart.index + dataStart[0].length);
  const video = objectStrings(script, videoStart.index + videoStart[0].length);
  if (!data?.title || video?.is_mp_video !== '1' || !/^wxv_\d+$/.test(video.video_id || '')) return null;
  // A video post is an intentional exclusion, not an empty article or a reason
  // to stop downloading subsequent text posts. Cache only its identity.
  return { ok: true, title: data.title.trim(), html: '', text: '', images: [], source: 'weread', content_kind: 'video', video_id: video.video_id };
}

export function parseContentResult(result) {
  if (!['missing_body', 'empty_body'].includes(result.code) || !result.diagnosticHtml) return result;
  return parseGalleryHtml(result.diagnosticHtml) || parseVideoHtml(result.diagnosticHtml) || result;
}

