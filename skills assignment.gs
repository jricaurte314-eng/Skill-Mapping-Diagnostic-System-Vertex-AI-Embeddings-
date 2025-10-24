/************************************
 * ============ Config =============
 ************************************/
var CFG_CA = {
  // === LLM ===
  MODEL: 'models/gemini-2.5-flash-lite',
  ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=',
  TEMPERATURE: 0.4,
  MAX_OUTPUT_TOKENS: 2048,

  // === Hojas (anónimas y consistentes con el resto del proyecto) ===
  PERSONAS_SHEET: 'roles_skills_levels', // antes: Cargos_Habilidades_Niveles
  CATALOG_SHEET:  'catalog_skills',      // antes: Catalogo_Habilidades
  START_ROW: 2,                          // encabezados en fila 1

  // Columnas lógicas de entrada (por encabezado, no por índice)
  COLS: {
    PERSONA: 'Correo',              // A (opcional)
    CARGO: 'Cargo',                 // B
    ACTIVIDADES: 'Actividades cargo'// C
  },

  // Salida: 3 sugerencias × [habilidad, nivel, justificación] → D..L
  OUT_COL_START: 4,          // D (1-based)
  OUT_COLS_PER_SUG: 3,
  OUT_SUG_COUNT: 3,
  CLEAR_DEST_BEFORE: true,   // limpiar D:L antes de escribir

  // Niveles permitidos (normalizados sin tildes)
  LEVELS: ['basico','intermedio','avanzado'],

  // Tamaños de lote y shortlist
  MAX_RETRIES: 3,
  MAX_ROWS_PER_BATCH: 20,    // personas por prompt
  SHORTLIST_K_PER_ITEM: 25,  // top-k por persona (léxico)
  SHORTLIST_MAX_UNION: 120,  // límite de catálogo por lote

  // Encabezados en catálogo (solo “Selección usuario” + opcional “Definición cliente”)
  CAT_COLS: {
    SELECCION: 'Selección usuario',
    DEF_CLIENTE: 'Definición cliente'
  },

  // Limites de justificación
  JUSTIF_MAX_WORDS: 20
};

/************************************
 * ========== Principal =============
 ************************************/
function sugerirHabilidadesBatch() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Hoja de personas / roles
  var sh = ss.getSheetByName(CFG_CA.PERSONAS_SHEET) ||
           ss.getSheetByName('Cargos_Habilidades_Niveles') ||  // fallback si aún no renombraste
           ss.getSheetByName('cargos_habilidades_niveles');
  if (!sh) throw new Error('No existe la hoja de personas: ' + CFG_CA.PERSONAS_SHEET);

  var lastRow = sh.getLastRow();
  if (lastRow < CFG_CA.START_ROW) return;

  // Limpia salida D..L
  if (CFG_CA.CLEAR_DEST_BEFORE) {
    var nRows = lastRow - CFG_CA.START_ROW + 1;
    var nCols = CFG_CA.OUT_SUG_COUNT * CFG_CA.OUT_COLS_PER_SUG;
    sh.getRange(CFG_CA.START_ROW, CFG_CA.OUT_COL_START, nRows, nCols).clearContent();
  }

  // Índice de encabezados (case/acentos-insensible)
  var H = _buildHeaderIndex_(sh);
  var cPersona = _colByName_(H, CFG_CA.COLS.PERSONA, false); // opcional
  var cCargo   = _colByName_(H, CFG_CA.COLS.CARGO, true);
  var cActiv   = _colByName_(H, CFG_CA.COLS.ACTIVIDADES, true);

  var maxReadCol = Math.max(cPersona || 1, cCargo, cActiv);
  var data = sh.getRange(CFG_CA.START_ROW, 1, lastRow - CFG_CA.START_ROW + 1, maxReadCol).getValues();

  // Construcción de candidatos
  var personas = [];
  for (var i = 0; i < data.length; i++) {
    var rowIndex = CFG_CA.START_ROW + i;
    var persona  = cPersona ? _valAtAbs_(data[i], cPersona) : '';
    var cargo    = _valAtAbs_(data[i], cCargo);
    var activ    = _valAtAbs_(data[i], cActiv);
    if (!cargo && !activ) continue;

    personas.push({
      row: rowIndex,
      persona: persona,
      cargo: cargo,
      actividades: activ,
      text: (cargo + ' | ' + activ).trim()
    });
  }
  if (personas.length === 0) return;

  // Catálogo (desde selección de usuario)
  var sc = ss.getSheetByName(CFG_CA.CATALOG_SHEET) || ss.getSheetByName('Catalogo_Habilidades');
  if (!sc) throw new Error('No existe la hoja de catálogo: ' + CFG_CA.CATALOG_SHEET);

  var catalogo = _readCatalogFromSelection_(sc);
  if (catalogo.length === 0) throw new Error('Catálogo sin habilidades válidas en "Selección usuario".');

  // Procesamiento por lotes
  var batches = _chunk(personas, CFG_CA.MAX_ROWS_PER_BATCH);
  batches.forEach(function(items){
    var subset = _shortlistCatalogForBatch(items, catalogo);
    var prompt = _buildBatchPrompt(items, subset);

    var apiKey = _getApiKey_();
    var payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: CFG_CA.TEMPERATURE, maxOutputTokens: CFG_CA.MAX_OUTPUT_TOKENS }
    };
    var url = CFG_CA.ENDPOINT + encodeURIComponent(apiKey);
    var options = { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true };

    var jsonOut = _callGeminiWithRetries_(url, options, function(json){
      var raw = _extractTextFromGemini_(json) || '';
      var clean = _stripCodeFences_(_normalizeQuotes_(raw)).trim();
      return _safeParseJson_(clean);
    });

    _writeBatchResults(sh, items, jsonOut);
  });
}

/************************************
 * ======= Encabezados / lectura ====
 ************************************/
function _buildHeaderIndex_(sh){
  var headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  var map = {};
  for (var c=0;c<headers.length;c++){
    var key = String(headers[c] || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .toLowerCase().trim();
    if (key) map[key] = c+1; // 1-based
  }
  return map;
}
function _colByName_(headerMap, headerText, required){
  var norm = String(headerText||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().trim();
  var idx = headerMap[norm];
  if (!idx && required !== false) throw new Error('No se encontró encabezado: ' + headerText);
  return idx || null;
}
function _valAtAbs_(rowArr, colIndex){ return String(rowArr[colIndex - 1] || '').trim(); }

/************************************
 * ======= Catálogo (selección) =====
 ************************************/
function _readCatalogFromSelection_(sc) {
  var lastRow = sc.getLastRow();
  if (lastRow < CFG_CA.START_ROW) return [];

  var Hc = _buildHeaderIndex_(sc);
  var cSel = _colByName_(Hc, CFG_CA.CAT_COLS.SELECCION, true);
  var cDef = _colByName_(Hc, CFG_CA.CAT_COLS.DEF_CLIENTE, false);

  var lastCol = sc.getLastColumn();
  var allRows = sc.getRange(CFG_CA.START_ROW, 1, lastRow - CFG_CA.START_ROW + 1, lastCol).getValues();

  var seen = new Map(); // habilidad(normalizada) -> {habilidad, definicion}
  for (var i=0; i<allRows.length; i++){
    var row = allRows[i];
    var sel = String(row[cSel - 1] || '').trim();
    if (!sel) continue;

    var def = cDef ? String(row[cDef - 1] || '').trim() : '';
    var key = _normalizeWord(sel);
    if (!seen.has(key)) {
      seen.set(key, { habilidad: sel, definicion: def });
    } else {
      var prev = seen.get(key);
      if ((def || '').length > (prev.definicion || '').length) {
        seen.set(key, { habilidad: sel, definicion: def });
      }
    }
  }
  return Array.from(seen.values());
}

/************************************
 * ====== Shortlist léxico rápido ===
 ************************************/
function _shortlistCatalogForBatch(items, catalog) {
  var stop = _spanishStopwords();
  var itemTokens = items.map(function(it){ return _tokenSet(it.text, stop); });

  var scoredUnion = new Map(); // habilidad -> score acumulado
  for (var i = 0; i < items.length; i++) {
    var scores = [];
    for (var j = 0; j < catalog.length; j++) {
      var t = _tokenSet(catalog[j].habilidad + ' ' + (catalog[j].definicion || ''), stop);
      var score = _overlapScore(itemTokens[i], t);
      if (itemTokens[i].has(_normalizeWord(catalog[j].habilidad))) score += 1.0; // bonus por mención exacta
      if (score > 0) scores.push({ idx: j, score: score });
    }
    scores.sort(function(a,b){ return b.score - a.score; });
    var take = Math.min(CFG_CA.SHORTLIST_K_PER_ITEM, scores.length);
    for (var k = 0; k < take; k++) {
      var cidx = scores[k].idx;
      var key = catalog[cidx].habilidad;
      var prev = scoredUnion.get(key) || 0;
      scoredUnion.set(key, prev + scores[k].score);
    }
  }

  var arr = [];
  scoredUnion.forEach(function(val, key){ arr.push({ habilidad: key, score: val }); });
  arr.sort(function(a,b){ return b.score - a.score; });

  var maxUnion = Math.min(CFG_CA.SHORTLIST_MAX_UNION, arr.length);
  var picked = arr.slice(0, maxUnion).map(function(x){ return x.habilidad; });
  var subset = catalog.filter(function(c){ return picked.indexOf(c.habilidad) >= 0; });

  // Fallback si nada matchea léxicamente
  if (subset.length === 0) subset = catalog.slice(0, Math.min(50, catalog.length));
  return subset;
}
function _normalizeWord(w) {
  return (w || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9áéíóúüñ ]/gi, ' ')
    .trim();
}
function _tokenSet(text, stop) {
  var toks = _normalizeWord(text).split(/\s+/).filter(function(t){
    return t && t.length >= 3 && !stop.has(t);
  });
  return new Set(toks);
}
function _overlapScore(aSet, bSet) {
  var s = 0; bSet.forEach(function(t){ if (aSet.has(t)) s += 1; });
  return s;
}
function _spanishStopwords() {
  var arr = ['los','las','unos','unas','el','la','de','del','y','o','u','en','con','por','para','segun','sin','sobre','entre',
    'a','al','lo','un','una','que','como','es','son','ser','estar','se','su','sus','ya','mas','más','muy','si','sí',
    'no','ni','le','les','me','mi','mis','tu','tus','esto','esta','estas','estos','ese','esa','eso','esas','esos',
    'cada','tal','cual','cuales','donde','dónde','cuando','cuándo','porque','porqué','qué','quien','quién','quienes',
    'debe','debes','deben','debo','deber','puede','pueden','puedo','podemos','hay','haber'];
  var s = new Set(); for (var i=0;i<arr.length;i++) s.add(arr[i]); return s;
}

/************************************
 * ======== Prompt por lote =========
 ************************************/
function _buildBatchPrompt(items, catalogSubset) {
  var candidatos = items.map(function(it, idx){
    return {
      idx: idx + 1,
      persona: it.persona || '',
      cargo: it.cargo || '',
      actividades: it.actividades || '',
      texto: it.text
    };
  });
  var cat = catalogSubset.map(function(c, i){
    return { id: i + 1, habilidad: c.habilidad, definicion: c.definicion || '' };
  });
  var niveles = CFG_CA.LEVELS.join('|');

  var instrucciones =
    'Eres un sistema de recomendación de habilidades para RR.HH.\n' +
    'Para CADA CANDIDATO elige EXACTAMENTE 3 habilidades del CATALOGO_CORTO (sin inventar habilidades nuevas).\n' +
    'Para cada habilidad asigna un nivel (' + CFG_CA.LEVELS.join(', ') + ') y una justificación breve (≤ ' + CFG_CA.JUSTIF_MAX_WORDS + ' palabras).\n' +
    'Contexto: español neutro corporativo.\n\n' +
    'Devuelve EXCLUSIVAMENTE JSON válido con formato EXACTO:\n' +
    '{ "resultados": [\n' +
    '  { "idx": <numero_del_candidato>, "sugerencias": [\n' +
    '    { "habilidad": "<texto>", "nivel": "' + niveles + '", "justificacion": "<≤' + CFG_CA.JUSTIF_MAX_WORDS + ' palabras>" },\n' +
    '    { "habilidad": "<texto>", "nivel": "' + niveles + '", "justificacion": "<≤' + CFG_CA.JUSTIF_MAX_WORDS + ' palabras>" },\n' +
    '    { "habilidad": "<texto>", "nivel": "' + niveles + '", "justificacion": "<≤' + CFG_CA.JUSTIF_MAX_WORDS + ' palabras>" }\n' +
    '  ]}\n' +
    ']}\n';

  return instrucciones +
         '\nCANDIDATOS:\n' + JSON.stringify(candidatos) +
         '\n\nCATALOGO_CORTO:\n' + JSON.stringify(cat);
}

/************************************
 * ======== Escritura salida =========
 ************************************/
function _writeBatchResults(sh, items, obj) {
  if (!obj || !obj.resultados || !Array.isArray(obj.resultados)) {
    Logger.log('Salida no parseable; no se escribe.');
    return;
  }
  var byIdx = new Map();
  obj.resultados.forEach(function(r){
    if (!r || typeof r.idx !== 'number' || !Array.isArray(r.sugerencias)) return;
    byIdx.set(r.idx, r.sugerencias);
  });

  var nCols = CFG_CA.OUT_SUG_COUNT * CFG_CA.OUT_COLS_PER_SUG;

  items.forEach(function(it, i){
    var sug = byIdx.get(i+1) || [];
    // Completa a 3 sugerencias
    while (sug.length < CFG_CA.OUT_SUG_COUNT) sug.push({ habilidad: '', nivel: '', justificacion: '' });

    // Normaliza orden y niveles
    var rowOut = [];
    for (var k=0; k<CFG_CA.OUT_SUG_COUNT; k++) {
      var hk = String((sug[k] && sug[k].habilidad) || '').trim();
      var nk = _normalizeLevel_((sug[k] && sug[k].nivel) || '');
      var jk = String((sug[k] && sug[k].justificacion) || '').trim();
      if (CFG_CA.LEVELS.indexOf(nk) < 0) nk = ''; // whitelist

      // recorte suave de justificación
      jk = _clipWords_(jk, CFG_CA.JUSTIF_MAX_WORDS);

      rowOut.push(hk, nk, jk);
    }
    sh.getRange(it.row, CFG_CA.OUT_COL_START, 1, nCols).setValues([rowOut]);
  });
}

/************************************
 * =========== Utilidades ===========
 ************************************/
function _chunk(arr, size){ var out=[]; for (var i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }
function _getApiKey_() {
  var sp = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (sp && sp.trim()) return sp.trim();
  var up = PropertiesService.getUserProperties().getProperty('GEMINI_API_KEY');
  if (up && up.trim()) return up.trim();
  throw new Error('Falta API Key. Define GEMINI_API_KEY en Script/User Properties.');
}
function _callGeminiWithRetries_(url, options, onOkParser) {
  var attempt = 0, backoffMs = 700;
  while (attempt < CFG_CA.MAX_RETRIES) {
    try {
      var res = UrlFetchApp.fetch(url, options);
      var code = res.getResponseCode();
      var body = res.getContentText();
      if (code >= 200 && code < 300) {
        var json = JSON.parse(body);
        return onOkParser(json);
      }
      if ((code === 429 || code >= 500) && attempt < CFG_CA.MAX_RETRIES - 1) {
        Utilities.sleep(backoffMs); backoffMs *= 2; attempt++; continue;
      }
      throw new Error('Gemini respondió ' + code + ': ' + body);
    } catch (e) {
      if (attempt < CFG_CA.MAX_RETRIES - 1) { Utilities.sleep(backoffMs); backoffMs *= 2; attempt++; continue; }
      Logger.log('Error final: ' + e); return null;
    }
  }
  return null;
}
function _extractTextFromGemini_(json) {
  if (json && json.candidates && json.candidates.length > 0) {
    var c = json.candidates[0];
    if (c && c.content && c.content.parts && c.content.parts.length > 0) {
      return c.content.parts.map(function (p) { return p.text || ''; }).join('').trim();
    }
  }
  if (json && json.contents && json.contents.length > 0 && json.contents[0].parts) {
    return json.contents[0].parts.map(function (p) { return p.text || ''; }).join('').trim();
  }
  return '';
}
function _stripCodeFences_(t){ return (t || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim(); }
function _normalizeQuotes_(t){ return (t || '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); }
function _safeParseJson_(t){ try { var obj = JSON.parse(t); if (obj && typeof obj === 'object') return obj; } catch(e){} return null; }
function _stripAccents_(s){ return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,''); }
function _normalizeLevel_(s){ return _stripAccents_(String(s||'').toLowerCase().trim()); }
function _oneLine_(t){ return (t||'').replace(/\r?\n+/g,' ').replace(/\s+/g,' ').trim(); }
function _clipWords_(s, max){ var toks=String(s||'').trim().split(/\s+/); return toks.length<=max ? toks.join(' ') : toks.slice(0,max).join(' ').replace(/[.,;:]?$/,''); }
