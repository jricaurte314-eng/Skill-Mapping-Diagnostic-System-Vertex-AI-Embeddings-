/************************************
 * ============ Config =============
 ************************************/
var CFG_EN = {
  // === LLM (texto) ===
  MODEL: 'models/gemini-2.5-flash-lite',
  ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=',
  TEMPERATURE: 0.4,
  MAX_OUTPUT_TOKENS: 8192,

  // === Hojas y columnas ===
  PERSONAS_SHEET: 'roles_skills_levels',   // antes: Cargos_Habilidades_Niveles
  CATALOG_SHEET:  'catalog_skills',        // antes: Catalogo_Habilidades
  START_ROW: 2,                            // encabezados en fila 1

  // Columnas de personas
  COL_PERSONA: 1,  // A (opcional)
  COL_CARGO:   2,  // B
  COL_ACTIV:   3,  // C

  // Sugerencias (D..L): 3 * [habilidad, nivel, justificación]
  OUT_COL_START: 4, // D
  OUT_COLS_PER_SUG: 3,
  OUT_SUG_COUNT: 3,

  // Control de ejecución
  MAX_RETRIES: 3,
  SURVEY_CLEAR_BEFORE: true,
  SURVEY_ITEMS_PER_SKILL: 4,
  SURVEY_MAX_ROWS_PER_BATCH: 2,    // personas por prompt (control de tokens)
  SURVEY_SCALE_LABEL: 'Likert 1-5',
  SURVEY_ITEM_MAX_WORDS: 22,

  // Niveles permitidos
  LEVELS: ['basico','intermedio','avanzado'],

  // Salida de encuestas
  SURVEY_SHEET: 'surveys'          // antes: encuestas
};

/************************************
 * =========== Helpers =============
 ************************************/
function _stripAccents_(s){ return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,''); }
function _normalizeLevel_(s){ return _stripAccents_(String(s||'').toLowerCase().trim()); }
function _oneLine_(t){ return (t||'').replace(/\r?\n+/g,' ').replace(/\s+/g,' ').trim(); }
function _clipWords_(s, maxWords){
  var toks = (String(s||'').trim().split(/\s+/));
  if (toks.length <= maxWords) return toks.join(' ');
  return toks.slice(0, maxWords).join(' ').replace(/[.,;:]?$/,'');
}
function _getSheetOrFallback_(ss, primary, fallbacks){
  return ss.getSheetByName(primary) || (fallbacks||[]).reduce(function(acc, name){ return acc || ss.getSheetByName(name); }, null);
}

/************************************
 * ====== Lectura de personas ======
 ************************************/
function _readAssignedSkillsFromRow_(rowArr) {
  // D/E/F -> S1 (habilidad, nivel, justificación)
  // G/H/I -> S2
  // J/K/L -> S3
  var out = [];
  var base = CFG_EN.OUT_COL_START - 1; // índice base (0-based)
  for (var s = 0; s < CFG_EN.OUT_SUG_COUNT; s++) {
    var idxH = base + s * CFG_EN.OUT_COLS_PER_SUG;     // habilidad
    var idxN = base + s * CFG_EN.OUT_COLS_PER_SUG + 1; // nivel
    var h = String(rowArr[idxH] || '').trim();
    var n = _normalizeLevel_(rowArr[idxN] || '');
    if (!h) continue;
    if (CFG_EN.LEVELS.indexOf(n) < 0) continue;
    out.push({ habilidad: h, nivel: n });
  }
  return out;
}

/************************************
 * ====== Hoja de salida (QA) ======
 ************************************/
function _ensureSurveySheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(CFG_EN.SURVEY_SHEET);
  if (!sh) sh = ss.insertSheet(CFG_EN.SURVEY_SHEET);
  var headers = ['Encuesta_ID','Persona','Cargo','Habilidad','Nivel','Ítem #','Enunciado','Tipo','Escala','Indicador'];
  if (sh.getLastRow() === 0) sh.appendRow(headers);
  else {
    var h = sh.getRange(1,1,1,headers.length).getValues()[0];
    if (h.join('¦') !== headers.join('¦')) { sh.clear(); sh.appendRow(headers); }
  }
  return sh;
}

/************************************
 * === Prompt batch de encuestas ===
 ************************************/
function _buildSurveyBatchPrompt_(items) {
  // Compacta información por persona → reduce tokens
  var candidatos = items.map(function(it, idx){
    return {
      idx: idx + 1,
      persona: it.persona || '',
      cargo: it.cargo || '',
      actividades: it.actividades || '',
      habilidades: it.asignadas // [{habilidad, nivel}]
    };
  });

  var reglas =
    'Eres un diseñador de instrumentos de evaluación laboral.\n' +
    'Para CADA candidato y CADA (habilidad, nivel), genera EXACTAMENTE ' + CFG_EN.SURVEY_ITEMS_PER_SKILL + ' ítems tipo Likert 1–5 ' +
    '(máximo ' + CFG_EN.SURVEY_ITEM_MAX_WORDS + ' palabras por enunciado) y un "indicador" breve (3–8 palabras).\n' +
    'Usa verbos observables. Ajusta la complejidad al nivel (básico=aplica/identifica; intermedio=analiza/resuelve; avanzado=diseña/optimiza/lidera).\n' +
    'No inventes habilidades; usa solo las provistas. Español neutro y contexto organizacional.\n\n' +
    'Devuelve EXCLUSIVAMENTE JSON válido con esta forma EXACTA:\n' +
    '{ "resultados":[\n' +
    '  { "idx": <n>, "encuesta":[\n' +
    '    { "habilidad":"...", "nivel":"basico|intermedio|avanzado", "items":[\n' +
    '      { "n":1, "enunciado":"...", "tipo":"likert", "escala":"1-5", "indicador":"..." }\n' +
    '    ]}\n' +
    '  ]}\n' +
    ']}\n';

  return reglas + '\nCANDIDATOS:\n' + JSON.stringify(candidatos);
}

/************************************
 * === Parseo y materialización =====
 ************************************/
function _materializeSurveyRows_(items, obj) {
  // Columnas: A: Encuesta_ID  B: Persona  C: Cargo  D: Habilidad  E: Nivel  F: Ítem #  G: Enunciado  H: Tipo  I: Escala  J: Indicador
  var rows = [];
  if (!obj || !Array.isArray(obj.resultados)) return rows;

  var mapByIdx = new Map();
  obj.resultados.forEach(function(r){
    if (r && typeof r.idx === 'number' && Array.isArray(r.encuesta)) mapByIdx.set(r.idx, r.encuesta);
  });

  var runId = Utilities.getUuid().slice(0, 8);

  items.forEach(function(it, localIdx){
    var bloques = mapByIdx.get(localIdx + 1) || [];
    // Reordena/filtra por las habilidades esperadas (si hay mismatch)
    var want = it.asignadas.map(function(p){ return (p.habilidad || '').toLowerCase().trim(); });
    if (bloques && want.length) {
      bloques.sort(function(a,b){
        var ai = want.indexOf(String(a.habilidad || '').toLowerCase().trim());
        var bi = want.indexOf(String(b.habilidad || '').toLowerCase().trim());
        if (ai < 0 && bi < 0) return 0;
        if (ai < 0) return 1;
        if (bi < 0) return -1;
        return ai - bi;
      });
      // Filtra solo las habilidades esperadas
      bloques = bloques.filter(function(b){
        return want.indexOf(String(b.habilidad || '').toLowerCase().trim()) >= 0;
      });
    }

    bloques.forEach(function(bloque, bIdx){
      if (!bloque || !Array.isArray(bloque.items)) return;
      var habilidad = String(bloque.habilidad || '').trim();
      var nivel = _normalizeLevel_(bloque.nivel || '');
      if (CFG_EN.LEVELS.indexOf(nivel) < 0) nivel = '';

      var encId = 'ENC-' + runId + '-' + it.row + '-' + (bIdx + 1);
      var kmax = Math.min(CFG_EN.SURVEY_ITEMS_PER_SKILL, bloque.items.length);

      for (var k=0; k<kmax; k++) {
        var item = bloque.items[k] || {};
        var n = item.n || (k + 1);
        var enun = _clipWords_(_oneLine_(item.enunciado || ''), CFG_EN.SURVEY_ITEM_MAX_WORDS);
        var tipo = String(item.tipo || 'likert').trim();
        var escala = String(item.escala || '1-5').trim();
        var indic = _oneLine_(item.indicador || '');

        rows.push([ encId, it.persona || '', it.cargo || '', habilidad, nivel, n, enun, tipo, escala, indic ]);
      }
    });
  });
  return rows;
}

/************************************
 * ====== Generar encuestas =========
 ************************************/
function generarEncuestasBatch() {
  var ss = getSpreadsheet_();

  // Personas / roles
  var sh = _getSheetOrFallback_(ss, CFG_EN.PERSONAS_SHEET, ['Cargos_Habilidades_Niveles', 'cargos_habilidades_niveles']);
  if (!sh) throw new Error('No encuentro la hoja de personas: ' + CFG_EN.PERSONAS_SHEET);

  var lastRow = sh.getLastRow();
  if (lastRow < CFG_EN.START_ROW) return;

  // Lee al menos D..L para 3 sugerencias
  var NUM_COLS_IN = Math.max(12, CFG_EN.OUT_COL_START - 1 + CFG_EN.OUT_SUG_COUNT * CFG_EN.OUT_COLS_PER_SUG);
  var data = sh.getRange(CFG_EN.START_ROW, 1, lastRow - CFG_EN.START_ROW + 1, NUM_COLS_IN).getValues();

  // Construye lista de personas con sus (habilidad, nivel)
  var personas = [];
  for (var i = 0; i < data.length; i++) {
    var rowIndex = CFG_EN.START_ROW + i;
    var persona = String(data[i][CFG_EN.COL_PERSONA - 1] || '').trim();
    var cargo   = String(data[i][CFG_EN.COL_CARGO   - 1] || '').trim();
    var activ   = String(data[i][CFG_EN.COL_ACTIV   - 1] || '').trim();
    var suggested = _readAssignedSkillsFromRow_(data[i]);  // [{habilidad,nivel}]
    if (suggested.length === 0) continue;

    personas.push({ row: rowIndex, persona: persona, cargo: cargo, actividades: activ, asignadas: suggested });
  }
  if (personas.length === 0) { SpreadsheetApp.getUi().alert('No hay habilidades/niveles asignados (D–L) para generar encuestas.'); return; }

  // Hoja de salida
  var shOut = _ensureSurveySheet_();
  if (CFG_EN.SURVEY_CLEAR_BEFORE) {
    var lr = shOut.getLastRow();
    if (lr >= 2) shOut.getRange(2, 1, lr - 1, shOut.getLastColumn()).clearContent();
  }

  // Procesa por lotes (1 prompt por lote)
  var batches = [];
  for (var i=0; i<personas.length; i += CFG_EN.SURVEY_MAX_ROWS_PER_BATCH) {
    batches.push(personas.slice(i, i + CFG_EN.SURVEY_MAX_ROWS_PER_BATCH));
  }

  var allRows = [];
  for (var b=0; b<batches.length; b++) {
    var items = batches[b];
    var prompt = _buildSurveyBatchPrompt_(items);

    var apiKey = getGeminiApiKey();
    var payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: CFG_EN.TEMPERATURE, maxOutputTokens: CFG_EN.MAX_OUTPUT_TOKENS }
    };
    var url = CFG_EN.ENDPOINT + encodeURIComponent(apiKey);
    var options = { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true };

    var obj = _callGeminiWithRetries_(url, options, function(json){
      var raw = _extractTextFromGemini_(json) || '';
      var clean = _stripCodeFences_(_normalizeQuotes_(raw)).trim();
      return _safeParseJson_(clean);
    });

    var rows = _materializeSurveyRows_(items, obj);
    if (rows.length) allRows = allRows.concat(rows);
  }

  // Escribe en bloque
  if (allRows.length) shOut.getRange(shOut.getLastRow() + 1, 1, allRows.length, allRows[0].length).setValues(allRows);

  SpreadsheetApp.getUi().alert('Encuestas generadas: ' + allRows.length + ' ítems escritos.');
}
