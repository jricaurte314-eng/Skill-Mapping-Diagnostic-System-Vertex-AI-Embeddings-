

var CFG = {
  MODEL: 'models/gemini-2.5-flash-lite', // puedes parametrizar/alternar modelos
  ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=',
  TEMPERATURE: 0.2,
  MAX_OUTPUT_TOKENS: 2048,

  // Hojas (genéricas para portafolio)
  SOURCE_SHEET: 'skills_raw',          
  INPUT_CLIENTE_SHEET: 'skills_client_enriched', 

  AUTO_SYNC_ON_PROCESS_ALL: true,
  MAX_RETRIES: 3,
  SYNC_START_ROW: 2,            // Encabezados en fila 1
  SOURCE_COLS: [1, 2],          // A: skill, B: definición original (usa B para IA)
  CLEAR_DEST_BEFORE_SYNC: true,

  // Preferir Script/User Properties para no exponer la key
  API_KEY: '',

  // === Taxonomía ===
  LEVEL_ORDER: ['basico', 'intermedio', 'avanzado'],
  TAXONOMY_COL_START: 4, // desde columna D

  // Reglas de limpieza/longitud (para salida de IA)
  MAX_LEVEL_LEN: 320, // caracteres máximos por nivel
  MAX_DEF_LEN: 480    // caracteres máximos para la definición mejorada
};

/************************************
 * ===== Sincronizar A/B ===========
 ************************************/
function syncSourceToCliente() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(CFG.SOURCE_SHEET);
  if (!src) throw new Error('No existe la hoja fuente: ' + CFG.SOURCE_SHEET);

  var dst = ss.getSheetByName(CFG.INPUT_CLIENTE_SHEET) || ss.insertSheet(CFG.INPUT_CLIENTE_SHEET);

  // Encabezados destino: A, B, C (mejorada), D..F (taxonomía)
  var levelHeadersNice = CFG.LEVEL_ORDER.map(function (k) {
    k = k.toLowerCase();
    if (k.indexOf('bas') === 0) return 'Nivel Básico';
    if (k.indexOf('inter') === 0) return 'Nivel Intermedio';
    if (k.indexOf('avan') === 0) return 'Nivel Avanzado';
    return 'Nivel ' + k;
  });
  var headers = ['Habilidad (A)', 'Definición original (B)', 'Definición mejorada (IA)']
    .concat(levelHeadersNice);

  if (CFG.CLEAR_DEST_BEFORE_SYNC) dst.clear();
  dst.getRange(1, 1, 1, headers.length).setValues([headers]);

  var lastRow = src.getLastRow();
  if (lastRow < CFG.SYNC_START_ROW) return;

  var startRow = CFG.SYNC_START_ROW;
  var numRows = lastRow - startRow + 1;

  var colA = CFG.SOURCE_COLS[0]; // 1
  var colB = CFG.SOURCE_COLS[1]; // 2
  var values = src.getRange(startRow, colA, numRows, 2).getValues();

  dst.getRange(CFG.SYNC_START_ROW, 1, values.length, 2).setValues(values);
}

/************************************
 * ===== Mejorar redacción =========
 ************************************/
function mejorarTodas() {
  if (CFG.AUTO_SYNC_ON_PROCESS_ALL) syncSourceToCliente();

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CFG.INPUT_CLIENTE_SHEET);
  if (!sh) throw new Error('No existe la hoja: ' + CFG.INPUT_CLIENTE_SHEET);

  var lastRow = sh.getLastRow();
  if (lastRow < CFG.SYNC_START_ROW) return;

  var out = [];
  for (var r = CFG.SYNC_START_ROW; r <= lastRow; r++) {
    var mejorada = _rewriteIfPossible_(r);
    out.push([mejorada]);
  }
  sh.getRange(CFG.SYNC_START_ROW, 3, out.length, 1).setValues(out); // C
}

// Utilidad para ejecutar por fila (depuración)
function _mejorarFila_(row) {
  var mejorada = _rewriteIfPossible_(row);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CFG.INPUT_CLIENTE_SHEET);
  sh.getRange(row, 3).setValue(mejorada); // C
}

function _rewriteIfPossible_(row) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.INPUT_CLIENTE_SHEET);
  var habilidad = String(sh.getRange(row, 1).getValue() || '').trim(); // A
  var definicion = String(sh.getRange(row, 2).getValue() || '').trim(); // B
  if (!definicion) return '';
  var text = _rewriteWithAI_(habilidad, definicion);
  return _clip(text, CFG.MAX_DEF_LEN);
}

/************************************
 * ========= Taxonomía Niveles =====
 ************************************/
function generarTaxonomiaTodas() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.INPUT_CLIENTE_SHEET);
  if (!sh) throw new Error('No existe la hoja: ' + CFG.INPUT_CLIENTE_SHEET);

  var lastRow = sh.getLastRow();
  if (lastRow < CFG.SYNC_START_ROW) return;

  for (var r = CFG.SYNC_START_ROW; r <= lastRow; r++) {
    _generarTaxonomiaEnFila_(r);
  }
}

function mejorarYTaxonomiaTodas() {
  mejorarTodas();
  generarTaxonomiaTodas();
}

function _generarTaxonomiaEnFila_(row) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.INPUT_CLIENTE_SHEET);

  var habilidad = String(sh.getRange(row, 1).getValue() || '').trim(); // A
  var defOriginal = String(sh.getRange(row, 2).getValue() || '').trim(); // B
  var defMejorada = String(sh.getRange(row, 3).getValue() || '').trim(); // C

  // Base para taxonomía: prioriza C si existe, si no B.
  var baseDef = defMejorada || defOriginal;
  if (!baseDef) {
    _writeTaxonomyRow_(row, { basico: '', intermedio: '', avanzado: '' });
    return;
  }

  var json = _taxonomyWithAI_(habilidad, baseDef); // {basico,intermedio,avanzado}
  // Limpieza y cortes de longitud por nivel
  json.basico = _clip(_sanitize_(json.basico || ''), CFG.MAX_LEVEL_LEN);
  json.intermedio = _clip(_sanitize_(json.intermedio || ''), CFG.MAX_LEVEL_LEN);
  json.avanzado = _clip(_sanitize_(json.avanzado || ''), CFG.MAX_LEVEL_LEN);

  _writeTaxonomyRow_(row, json);
}

function _writeTaxonomyRow_(row, jsonTax) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CFG.INPUT_CLIENTE_SHEET);

  var map = _normalizeLevelMap_(jsonTax);
  var out = [];
  CFG.LEVEL_ORDER.forEach(function (key) {
    var k = key.toLowerCase();
    out.push(map[k] || '');
  });
  sh.getRange(row, CFG.TAXONOMY_COL_START, 1, out.length).setValues([out]);
}

/************************************
 * ===== Llamadas a la API =========
 ************************************/
function _rewriteWithAI_(habilidad, definicion) {
  var apiKey = _getApiKey_();
  var prompt = _buildPromptRewrite_(habilidad, definicion);

  var payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: CFG.TEMPERATURE,
      maxOutputTokens: CFG.MAX_OUTPUT_TOKENS
    }
  };

  var url = CFG.ENDPOINT + encodeURIComponent(apiKey);
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  return _callGeminiWithRetries_(url, options, function (json) {
    var text = _extractTextFromGemini_(json);
    // Limpieza estricta
    text = _sanitize_(text || '');
    // Una sola línea, sin bullets
    text = _oneLine_(text);
    return text;
  });
}

function _taxonomyWithAI_(habilidad, definicionBase) {
  var apiKey = _getApiKey_();
  var prompt = _buildPromptTaxonomy_(habilidad, definicionBase);

  var payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: CFG.TEMPERATURE,
      maxOutputTokens: CFG.MAX_OUTPUT_TOKENS
    }
  };

  var url = CFG.ENDPOINT + encodeURIComponent(apiKey);
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  return _callGeminiWithRetries_(url, options, function (json) {
    var raw = _extractTextFromGemini_(json) || '';
    var clean = _stripCodeFences_(_normalizeQuotes_(raw)).trim();
    var obj = _safeParseJson_(clean);
    if (!obj) obj = _heuristicSplitBySections_(clean);
    return obj || { basico: '', intermedio: '', avanzado: '' };
  });
}

function _callGeminiWithRetries_(url, options, onOkParser) {
  var attempt = 0, backoffMs = 750;
  while (attempt < CFG.MAX_RETRIES) {
    try {
      var res = UrlFetchApp.fetch(url, options);
      var code = res.getResponseCode();
      var body = res.getContentText();

      if (code >= 200 && code < 300) {
        var json = JSON.parse(body);
        return onOkParser(json);
      }

      // backoff para 429/5xx
      if ((code === 429 || code >= 500) && attempt < CFG.MAX_RETRIES - 1) {
        Utilities.sleep(backoffMs); backoffMs *= 2; attempt++; continue;
      }
      throw new Error('Gemini respondió ' + code + ': ' + _safeTruncate_(body, 400));

    } catch (e) {
      if (attempt < CFG.MAX_RETRIES - 1) {
        Utilities.sleep(backoffMs); backoffMs *= 2; attempt++; continue;
      }
      Logger.log('Error final: ' + e);
      return { basico: '', intermedio: '', avanzado: '' };
    }
  }
  return { basico: '', intermedio: '', avanzado: '' };
}

/************************************
 * ========== Prompts ==============
 ************************************/
function _buildPromptRewrite_(habilidad, definicion) {
  var titulo = habilidad ? ('Habilidad: ' + habilidad + '\n') : '';
  return (
    'Eres un editor experto en español corporativo claro y conciso.\n' +
    'Mejorarás la redacción de la SIGUIENTE definición SIN cambiar su significado, eliminando redundancias y jerga innecesaria, en voz activa y tono neutral-profesional. ' +
    'Devuelve SOLO la definición mejorada, sin viñetas, sin encabezados y sin explicaciones adicionales.\n\n' +
    titulo +
    'Definición original:\n' + definicion + '\n\n' +
    'Requisitos:\n' +
    '- Mantén el sentido original.\n' +
    '- Sé preciso y directo.\n' +
    '- Longitud sugerida: 1 a 3 frases.\n' +
    '- Español neutro para contexto organizacional.\n'
  );
}

function _buildPromptTaxonomy_(habilidad, definicionBase) {
  var titulo = habilidad ? ('Habilidad: ' + habilidad + '\n') : '';
  return (
    'Genera una TAXONOMÍA de la habilidad en TRES niveles claros y medibles para contexto laboral.\n' +
    'Usa la definición base a continuación.\n\n' +
    titulo +
    'Definición base:\n' + definicionBase + '\n\n' +
    'Instrucciones clave:\n' +
    '- Define exactamente 3 niveles: basico, intermedio, avanzado (en minúsculas, claves JSON).\n' +
    '- Cada nivel debe describir competencias observables en 1–3 frases, sin viñetas.\n' +
    '- Evita tecnicismos innecesarios; usa verbos observables (ej.: identifica, aplica, diseña, optimiza...).\n' +
    '- Mantén consistencia entre niveles (creciente autonomía, complejidad y alcance de impacto).\n' +
    '- Devuelve EXCLUSIVAMENTE JSON válido, sin envoltorios, sin comentarios, sin markdown.\n' +
    '- Estructura:\n' +
    '{\"basico\":\"...\",\"intermedio\":\"...\",\"avanzado\":\"...\"}\n'
  );
}

/************************************
 * ======= Helpers / Parsing =======
 ************************************/
function _getApiKey_() {
  if (CFG.API_KEY && CFG.API_KEY.trim()) return CFG.API_KEY.trim();
  var sp = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (sp && sp.trim()) return sp.trim();
  var up = PropertiesService.getUserProperties().getProperty('GEMINI_API_KEY');
  if (up && up.trim()) return up.trim();
  throw new Error('Falta API Key. Define CFG.API_KEY o GEMINI_API_KEY en Script/User Properties.');
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

function _sanitize_(text) {
  return (text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^```|```$/g, '')
    .replace(/^\s*[-•*]\s*/gm, '') // bullets
    .replace(/\s+/g, ' ')
    .trim();
}
function _oneLine_(t){ return (t || '').replace(/\r?\n+/g, ' ').trim(); }
function _stripCodeFences_(t){ return (t || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim(); }
function _normalizeQuotes_(t){ return (t || '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); }
function _safeParseJson_(t){ try { var o = JSON.parse(t); if (o && typeof o === 'object') return o; } catch(e){} return null; }
function _normalizeLevelMap_(obj) {
  var out = { basico: '', intermedio: '', avanzado: '' };
  if (!obj) return out;
  Object.keys(obj).forEach(function (k) {
    var key = k.toLowerCase().trim()
      .replace('básico', 'basico')
      .replace('avanzada', 'avanzado');
    if (key.indexOf('basi') === 0) out.basico = String(obj[k] || '').trim();
    else if (key.indexOf('inter') === 0) out.intermedio = String(obj[k] || '').trim();
    else if (key.indexOf('avan') === 0) out.avanzado = String(obj[k] || '').trim();
  });
  return out;
}
function _heuristicSplitBySections_(t) {
  var bas = '', inter = '', avan = '';
  var s = (t || '').replace(/\r/g, '');
  var re = /(b[áa]sico|intermedio|avanzado)\s*[:\-]\s*/i;
  var parts = s.split(re);
  for (var i = 1; i < parts.length; i += 2) {
    var key = parts[i].toLowerCase();
    var val = (parts[i + 1] || '').split(/\n{2,}|$/)[0];
    if (/b[áa]sico/.test(key)) bas = _oneLine_(val).trim();
    else if (/intermedio/.test(key)) inter = _oneLine_(val).trim();
    else if (/avanzado/.test(key)) avan = _oneLine_(val).trim();
  }
  return { basico: bas, intermedio: inter, avanzado: avan };
}
function _clip(s, max){ s = String(s || ''); return s.length > max ? s.slice(0, max - 1).trim() + '…' : s; }
function _safeTruncate_(s, n){ s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }
