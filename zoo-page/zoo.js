"use strict";

(() => {
  const get = id => document.getElementById(id);
  const directory = "./zoo-data/";
  const dimensions = [
    ["all", "All"], ["1", "Plane curves"], ["2", "Surfaces"], ["3", "Threefolds"],
    ["4", "Fourfolds"], ["higher", "Higher dimensions"],
  ];
  const pageSize = 40;
  const recordCache = new Map();
  let entries = [];
  let dimension = "all";
  let matches = null;
  let visible = [];
  let page = 0;
  let selected = null;
  let searchError = "";
  let searchRequest;
  let recordRequest;
  let debounce;

  // The native parser serializes the exact sparse terms in descending lex order.
  // Presentation uses their coordinate positions, even when the input used other names.
  function equationView(entry) {
    const axes = ["x", "y", "z", "w", "u", "v"];
    const variables = entry.variables.map((_, i) => axes[i] || `x${i + 1}`);
    function format(style) {
      return entry.terms.map(({coefficient, exponents}, index) => {
        const negative = coefficient.startsWith("-");
        const [num, den] = (negative ? coefficient.slice(1) : coefficient).split("/");
        const factors = [];
        for (const [i, exponent] of exponents.entries()) {
          if (exponent === "0") continue;
          let name = variables[i];
          if (style === "latex" && i >= axes.length) name = `x_{${i + 1}}`;
          if (exponent !== "1") {
            if (style === "latex") name += `^{${exponent}}`;
            else name += (style === "python" ? "**" : "^") + exponent;
          }
          factors.push(name);
        }
        let scalar = num;
        if (den && style !== "python") {
          scalar = style === "latex" ? `\\frac{${num}}{${den}}` : `${num}/${den}`;
        }
        if (scalar !== "1" || !factors.length) factors.unshift(scalar);
        let term = factors.join(style === "latex" ? "" : "*");
        // Dividing after the symbolic product retains exact rationals in Python CASes.
        if (den && style === "python") term += "/" + den;
        const sign = index === 0 ? (negative ? "-" : "") : (negative ? " - " : " + ");
        return sign + term;
      }).join("");
    }
    return {display: format("display"), python: format("python"), latex: format("latex"), variables};
  }

  function groupOf(entry) {
    return entry.dimension > 4 ? "higher" : String(entry.dimension);
  }

  async function getJSON(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Could not load the catalogue data (HTTP ${response.status}).`);
    }
    return readRecord(await response.text());
  }

  async function queryCatalogue(query, sourceEntries, signal) {
    const result = typeof window.atlasZooSearch === "function"
      ? await window.atlasZooSearch(query, sourceEntries, {signal})
      : await getJSON("../api/zoo/search", {signal, method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({query})});
    if (!Array.isArray(result.ids)) throw new Error("The search returned an invalid response.");
    return result.ids;
  }

  function action(text, handler) {
    const button = el("button", "button", text);
    button.type = "button";
    button.addEventListener("click", handler);
    return button;
  }

  function entryURL(id) {
    const url = new URL(location.href);
    if (id) url.searchParams.set("record", id);
    else url.searchParams.delete("record");
    return url;
  }

  function recordURL(id) {
    return directory + "records/" + encodeURIComponent(id) + ".json";
  }

  function setAddress(id, addHistory = false) {
    const url = entryURL(id);
    if (url.href !== location.href) history[addHistory ? "pushState" : "replaceState"](null, "", url);
  }

  const labels = {
    id: "ID", chart_count: "Affine charts", nu: "ν", nearby_strata: "Nearby strata",
    monodromy: "Monodromy", poles: "Poles", strata: "Strata over the origin",
    steps: "Blowups and modifications", dual_complex: "Exceptional intersections",
    numerical_data: "Divisor numerical data", vertices: "Vertices", cells: "Intersection cells",
    self_intersection: "Self-intersection", pole_check: "Pole witnesses",
    center_charts: "Center in each chart", center_ideal: "Center ideal", locus_equations: "Locus equations",
    milnor_fiber_euler_characteristic: "Milnor fibre Euler characteristic", formula: "Formula",
  };
  function fieldLabel(key) {
    return labels[key] || key.replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
  }

  function fold(title, content, {main = false, state = "", open = false} = {}) {
    const box = el("details", main ? "zoo-fold" : "zoo-subfold");
    const summary = el("summary");
    summary.append(el(main ? "h3" : "span", "", title));
    if (state) summary.append(" ", el("span", "zoo-state", state));
    const body = el("div", main ? "zoo-fold-body" : "zoo-subbody");
    const populate = () => {
      if (!box.open || body.hasChildNodes()) return;
      body.append(content());
    };
    box.append(summary, body);
    box.open = open;
    populate();
    box.addEventListener("toggle", populate);
    return box;
  }

  const mathFields = new Set([
    "expression", "equation", "numerator", "denominator", "polynomial", "transverse_germ",
    "strict_transform", "generators", "center_ideal", "ideal", "locus_equations", "value",
  ]);
  const scalar = value => value === null || typeof value !== "object";
  const simpleCell = value => scalar(value) || (Array.isArray(value) && value.every(scalar));

  function displayValue(key, value) {
    if (value === null || value === undefined) return document.createTextNode("—");
    if (typeof value === "boolean") return document.createTextNode(value ? "Yes" : "No");
    if (scalar(value)) {
      if (typeof value === "string" && mathFields.has(key)) return typeset(value);
      return document.createTextNode(String(value));
    }
    if (!Array.isArray(value)) return fieldList(Object.entries(value));

    if (!value.length) return el("span", "helper", "None recorded");
    if (value.every(scalar)) {
      const inline = el("span");
      value.forEach((item, i) => {
        if (i) inline.append(", ");
        inline.append(displayValue(key, item));
      });
      return inline;
    }
    if (value.every(row => row && !Array.isArray(row) && typeof row === "object")) {
      const keys = [...new Set(value.flatMap(Object.keys))];
      if (keys.length <= 6 && value.every(row => Object.values(row).every(simpleCell))) {
        const wrap = el("div", "zoo-grid");
        const table = el("table");
        const head = table.createTHead().insertRow();
        keys.forEach(name => {
          const cell = el("th", "", fieldLabel(name));
          cell.scope = "col";
          head.append(cell);
        });
        const body = table.createTBody();
        for (const row of value) {
          const tr = body.insertRow();
          keys.forEach(name => tr.insertCell().append(displayValue(name, row[name])));
        }
        wrap.append(table);
        return wrap;
      }
    }
    const rows = el("ul", "zoo-rows");
    for (const [index, item] of value.entries()) {
      const row = el("li");
      if (item && !Array.isArray(item) && typeof item === "object") {
        const name = item.id ?? item.component ?? item.model ?? item.value ?? String(index + 1);
        row.append(fold(String(name), () => fieldList(Object.entries(item))));
      } else row.append(displayValue(key, item));
      rows.append(row);
    }
    return rows;
  }

  function fieldList(fields) {
    const list = el("dl", "zoo-data-list");
    for (const [key, value] of fields) {
      const dd = el("dd");
      dd.append(displayValue(key, value));
      list.append(el("dt", "", fieldLabel(key)), dd);
    }
    return list;
  }

  function remainingFields(data, skip) {
    return Object.entries(data).filter(([key]) => !skip.includes(key));
  }

  function fieldFold(key, value) {
    const count = Array.isArray(value) ? ` (${value.length})` : "";
    return fold(fieldLabel(key) + count, () => displayValue(key, value));
  }

  function nearbyStrata(strata, variable) {
    return fold(`Nearby strata (${strata.length})`, () => {
      if (!strata.length) return el("p", "helper", "No nearby strata recorded.");
      const list = el("ul", "zoo-rows");
      for (const stratum of strata) {
        const row = el("li", "zoo-nearby");
        const formula = el("span", "m");
        formula.setAttribute("role", "math");
        formula.setAttribute("aria-label", stratum.expression);
        formula.append(zetaQuotient(stratum, variable));
        row.append(stratumLocus(stratum), formula, fold("Stratum data", () => fieldList(Object.entries(stratum))));
        list.append(row);
      }
      return list;
    });
  }

  function complexView(dual, branches) {
    const wrap = el("div", "zoo-graph");
    const { vertices = [], cells = [] } = dual;
    if (dual.convention) wrap.append(el("p", "helper", dual.convention));
    if (dual.reason) wrap.append(el("p", "notice", dual.reason));
    let picked = null;
    let highlight;
    const vertexInfo = el("div", "zoo-vertex");
    const figure = drawGraph(vertices, cells, branches, id => {
      picked = picked === id ? null : id;
      highlight(picked);
      const vertex = vertices.find(item => String(item.id) === picked);
      vertexInfo.replaceChildren();
      if (vertex) vertexInfo.append(fieldList(Object.entries(vertex)));
    }, update => { highlight = update; });
    if (figure) wrap.append(figure, vertexInfo);
    if (!vertices.length && dual.status === "complete") {
      wrap.append(el("p", "helper", "The exceptional divisor is empty."));
    }
    wrap.append(fieldFold("vertices", vertices), fieldFold("cells", cells));
    const extra = remainingFields(dual, ["status", "convention", "reason", "vertices", "cells"]);
    if (extra.length) wrap.append(fieldList(extra));
    return wrap;
  }

  function resolutionSection(title, data, open) {
    const content = () => {
      const body = el("div", "zoo-section-content");
      if (!data) return el("p", "helper", "No resolution recorded.");
      if (data.summary) body.append(el("p", "", data.summary));
      const fields = ["engine", "multiplicity", "chart_count", "reason"].filter(key => key in data);
      if (fields.length) body.append(fieldList(fields.map(key => [key, data[key]])));
      if (data.dual_complex) {
        const dual = data.dual_complex;
        body.append(fold("Exceptional intersections", () => complexView(dual, data.branches || []),
          {state: dual.status, open: true}));
      }
      if (data.steps) body.append(fieldFold("steps", data.steps));
      for (const [key, value] of remainingFields(data, [...fields, "summary", "status", "dual_complex", "steps"])) {
        body.append(fieldFold(key, value));
      }
      return body;
    };
    return fold(title, content, {main: true, state: data?.status || "Unavailable", open});
  }

  function zetaSection(title, data) {
    return fold(title, () => {
      const body = el("div", "zoo-section-content");
      if (!data) return el("p", "helper", "No zeta function recorded.");
      if (data.expression !== undefined) {
        const expression = el("p", "zoo-expression m");
        expression.setAttribute("role", "math");
        expression.setAttribute("aria-label", data.expression);
        if (Array.isArray(data.factors)) expression.append(zetaQuotient(data, data.variable || "T"));
        else if (data.numerator && data.denominator && data.denominator !== "1") {
          const quotient = el("span", "quotient");
          quotient.append(typeset(data.numerator), typeset(data.denominator));
          expression.append(quotient);
        } else expression.append(typeset(data.expression));
        body.append(el("p", "helper", "At the origin"), expression);
      }
      const fields = ["reason", "method", "milnor_fiber_euler_characteristic"].filter(key => key in data);
      if (fields.length) body.append(fieldList(fields.map(key => [key, data[key]])));
      if (Array.isArray(data.nearby_strata)) body.append(nearbyStrata(data.nearby_strata, data.variable || "T"));
      for (const key of ["strata", "numerical_data", "poles", "contributions", "factors"]) {
        if (key in data) body.append(fieldFold(key, data[key]));
      }
      return body;
    }, {main: true, state: data?.status || "Unavailable"});
  }

  function equationNode(source) {
    const node = typeset(source, " = 0");
    node.setAttribute("role", "math");
    node.setAttribute("aria-label", source + " = 0");
    return node;
  }

  function recordActions(record, equation) {
    const tools = el("div", "zoo-record-actions");
    const buttons = el("div", "zoo-record-buttons");
    const status = el("p", "zoo-copy-status");
    status.setAttribute("role", "status");
    const source = el("textarea");
    source.hidden = true;
    source.readOnly = true;
    source.rows = 2;
    for (const [format, text] of [["LaTeX", equation.latex], ["Python", equation.python]]) {
      const button = action("Copy " + format, async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          if (!tools.isConnected) return;
          source.value = text;
          source.setAttribute("aria-label", format + " expression");
          source.hidden = false;
          source.focus();
          source.select();
          let copied = false;
          try {
            copied = document.execCommand("copy");
          } catch { /* The browser can also block selection-based copying. */ }
          if (!copied) {
            status.textContent = "Use your device’s copy command on the selected expression.";
            return;
          }
          button.focus();
        }
        source.hidden = true;
        status.textContent = format + " copied.";
      });
      buttons.append(button);
    }
    const download = el("a", "", "Download JSON");
    download.href = recordURL(record.id);
    download.download = record.id + ".json";
    buttons.append(download);
    tools.append(buttons, status, source);
    return tools;
  }

  function renderRecord(record) {
    if (record.schema_version !== 1) throw new Error("This record uses an unsupported catalogue format.");
    const equation = equationView(record);
    const header = el("header", "zoo-record-head");
    const title = el("h2");
    title.append(equationNode(equation.display));
    header.append(title);
    if (record.name?.trim()) header.append(el("p", "zoo-record-name", record.name));
    const tags = el("ul", "zoo-tags");
    tags.setAttribute("aria-label", "Labels");
    for (const tag of record.labels) tags.append(el("li", "zoo-tag", tag));
    header.append(tags, recordActions(record, equation));
    const location = el("p", "zoo-location");
    location.append(`In ${record.base_field}[${equation.variables.join(", ")}] at (${record.origin.join(", ")}).`);
    if (record.geometric_field) {
      const field = record.geometric_field === "algebraic closure of Q" ? "the algebraic closure of Q" : record.geometric_field;
      location.append(" Geometry over " + field + ".");
    }
    equation.variables.forEach((name, i) => {
      if (name !== record.variables[i]) location.append(" ", typeset(name), " is ", typeset(record.variables[i]), " in the resolution data.");
    });
    const fragment = document.createDocumentFragment();
    fragment.append(header, location);
    const engine = record.zeta?.monodromy?.resolution_engine || record.embedded?.engine;
    if (engine) {
      const engineRow = el("dl", "zoo-record-engine");
      engineRow.append(el("dt", "", "Resolution engine"), el("dd", "", engine));
      fragment.append(engineRow);
    }
    if (record.invariants) {
      const invariants = el("dl", "zoo-invariants");
      for (const [key, value] of Object.entries(record.invariants)) {
        const pair = el("div");
        let shown;
        if (value && typeof value === "object" && "finite" in value) {
          shown = value.finite ? String(value.value) : "∞";
        }
        pair.append(el("dt", "", fieldLabel(key)), el("dd", "", shown ?? String(value)));
        invariants.append(pair);
      }
      fragment.append(invariants);
    }
    fragment.append(resolutionSection("Intrinsic resolution", record.intrinsic, true),
      resolutionSection("Embedded resolution", record.embedded, false),
      zetaSection("Monodromy zeta function", record.zeta?.monodromy),
      zetaSection("Topological zeta function", record.zeta?.topological));
    if (record.zeta?.pole_check) fragment.append(fieldFold("pole_check", record.zeta.pole_check));
    return fragment;
  }

  function updateSelection() {
    for (const link of get("zoo-list").querySelectorAll("a")) {
      if (link.dataset.id === selected) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  }

  async function selectEntry(entry, {fromClick = false, retry = false} = {}) {
    if (fromClick) setAddress(entry.id, true);
    const detail = get("zoo-detail");
    if (fromClick && matchMedia("(max-width: 660px)").matches) {
      detail.focus({preventScroll: true});
      detail.scrollIntoView({block: "start"});
    }
    if (selected === entry.id && !retry) return;
    recordRequest?.abort();
    const controller = new AbortController();
    recordRequest = controller;
    selected = entry.id;
    updateSelection();
    detail.setAttribute("aria-busy", "true");
    detail.replaceChildren(el("p", "helper", "Loading resolution…"));
    try {
      let record = recordCache.get(entry.id);
      if (!record) {
        record = await getJSON(recordURL(entry.id), {signal: controller.signal});
        if (controller.signal.aborted) return;
        recordCache.set(entry.id, record);
        if (recordCache.size > 10) recordCache.delete(recordCache.keys().next().value);
      }
      detail.replaceChildren(renderRecord(record));
    } catch (error) {
      if (!controller.signal.aborted) {
        detail.replaceChildren(el("p", "error", error.message),
          action("Retry record", () => selectEntry(entry, {retry: true})));
      }
    } finally {
      if (!controller.signal.aborted) detail.removeAttribute("aria-busy");
    }
  }

  function clearDetail(message) {
    recordRequest?.abort();
    selected = null;
    const detail = get("zoo-detail");
    detail.removeAttribute("aria-busy");
    detail.replaceChildren(el("p", "zoo-detail-empty", message));
  }

  function renderPage(preferred, unknownRecord = false) {
    const start = page * pageSize;
    const rows = visible.slice(start, start + pageSize);
    const fragment = document.createDocumentFragment();
    rows.forEach(entry => {
      const li = el("li");
      const link = el("a");
      link.href = entryURL(entry.id);
      link.dataset.id = entry.id;
      const equation = equationView(entry);
      link.title = equation.display + " = 0";
      link.append(equationNode(equation.display));
      link.addEventListener("click", event => {
        if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        selectEntry(entry, {fromClick: true});
      });
      li.append(link);
      fragment.append(li);
    });
    get("zoo-list").replaceChildren(fragment);
    get("zoo-list").scrollTop = 0;
    get("zoo-count").textContent = plural(visible.length, "record", "records");
    get("zoo-pages").hidden = visible.length <= pageSize;
    get("zoo-range").textContent = `${start + 1}–${start + rows.length}`;
    get("zoo-prev").disabled = page === 0;
    get("zoo-next").disabled = start + pageSize >= visible.length;
    if (unknownRecord) {
      clearDetail("This record could not be found. Choose an entry from the catalogue.");
      return;
    }
    if (rows.length) {
      const entry = rows.find(row => row.id === preferred) || rows[0];
      selectEntry(entry);
      updateSelection();
      const selectedLink = get("zoo-list").querySelector("[aria-current]");
      if (selectedLink) {
        const list = get("zoo-list");
        if (selectedLink.getBoundingClientRect().bottom > list.getBoundingClientRect().bottom) {
          list.scrollTop = selectedLink.getBoundingClientRect().top - list.getBoundingClientRect().top;
        }
      }
      if (new URLSearchParams(location.search).has("record")) setAddress(entry.id);
      return;
    }
    clearDetail("Select a catalogue entry to view its resolution.");
    if (new URLSearchParams(location.search).has("record")) setAddress(null);
  }

  function resetFilters() {
    clearTimeout(debounce);
    searchRequest?.abort();
    get("zoo-query").value = "";
    get("zoo-query").removeAttribute("aria-invalid");
    searchError = "";
    get("zoo-label").value = "";
    dimension = "all";
    matches = null;
    filter();
  }

  function filter(preferred = selected, unknownRecord = false) {
    const tag = get("zoo-label").value;
    const candidates = entries.filter(entry => (!tag || entry.labels.includes(tag)) && (!matches || matches.has(entry.id)));
    const counts = new Map([["all", candidates.length]]);
    for (const entry of candidates) {
      const group = groupOf(entry);
      counts.set(group, (counts.get(group) || 0) + 1);
    }
    for (const button of get("zoo-dimensions").children) {
      button.setAttribute("aria-pressed", String(button.value === dimension));
      button.lastChild.textContent = String(counts.get(button.value) || 0);
    }
    visible = dimension === "all" ? candidates : candidates.filter(entry => groupOf(entry) === dimension);
    const index = visible.findIndex(entry => entry.id === preferred);
    page = index < 0 ? 0 : Math.floor(index / pageSize);
    get("zoo-feedback").replaceChildren();
    if (!visible.length) {
      const categoryEmpty = dimension !== "all" && !entries.some(entry => groupOf(entry) === dimension);
      get("zoo-feedback").append(el("p", "", categoryEmpty ? "No records in this dimension yet." : "No records match these filters."),
        action("Clear filters", resetFilters));
    }
    renderPage(preferred, unknownRecord);
    if (searchError) {
      get("zoo-count").textContent = "Search unavailable";
      get("zoo-feedback").replaceChildren(el("p", "error", searchError), action("Clear filters", resetFilters));
    }
  }

  function search() {
    clearTimeout(debounce);
    searchRequest?.abort();
    const query = get("zoo-query").value.trim();
    searchError = "";
    get("zoo-query").removeAttribute("aria-invalid");
    if (!query) {
      matches = null;
      filter();
      return;
    }
    get("zoo-count").textContent = "Searching…";
    const controller = new AbortController();
    searchRequest = controller;
    debounce = setTimeout(async () => {
      try {
        const ids = await queryCatalogue(query, entries, controller.signal);
        if (controller.signal.aborted) return;
        matches = new Set(ids);
        filter();
      } catch (error) {
        if (controller.signal.aborted) return;
        matches = new Set();
        searchError = error.message;
        filter();
        get("zoo-query").setAttribute("aria-invalid", "true");
      }
    }, 100);
  }

  function followAddress() {
    const id = new URL(location.href).searchParams.get("record");
    if (id && !entries.some(entry => entry.id === id)) {
      filter(null, true);
      return;
    }
    const filtered = dimension !== "all" || get("zoo-label").value || get("zoo-query").value;
    if (id && filtered && !visible.some(entry => entry.id === id)) resetFilters();
    filter(id);
  }

  function bindSearchHelp() {
    const help = get("zoo-help");
    const trigger = help.querySelector("summary");
    let pinned = false;
    function close() {
      pinned = false;
      help.open = false;
    }
    help.addEventListener("pointerenter", event => {
      if (event.pointerType !== "touch") help.open = true;
    });
    help.addEventListener("pointerleave", event => {
      if (event.pointerType !== "touch" && !pinned && !trigger.matches(":focus-visible")) close();
    });
    trigger.addEventListener("focus", () => {
      if (trigger.matches(":focus-visible")) help.open = true;
    });
    trigger.addEventListener("blur", close);
    trigger.addEventListener("click", event => {
      event.preventDefault();
      pinned = !pinned;
      help.open = pinned;
    });
    document.addEventListener("pointerdown", event => {
      if (help.open && !help.contains(event.target)) close();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && help.open) close();
    });
  }

  async function init() {
    get("zoo-loading").hidden = false;
    get("zoo-feedback").replaceChildren();
    try {
      const index = await getJSON(directory + "index.json");
      if (index.schema_version !== 1 || !Array.isArray(index.entries)) {
        throw new Error("This index uses an unsupported catalogue format.");
      }
      const ids = await queryCatalogue("", index.entries, new AbortController().signal);
      const byId = new Map(index.entries.map(entry => [entry.id, entry]));
      entries = ids.map(id => byId.get(id));
      if (entries.length !== byId.size || entries.includes(undefined)) {
        throw new Error("The catalogue changed while loading. Reload it to see the updated records.");
      }
      for (const tag of [...new Set(entries.flatMap(entry => entry.labels))].sort((a, b) => a.localeCompare(b))) {
        get("zoo-label").add(new Option(tag, tag));
      }
      for (const [group, label] of dimensions) {
        const button = el("button", "", label);
        button.type = "button";
        button.value = group;
        button.append(el("span", "zoo-dimension-count"));
        button.addEventListener("click", () => { dimension = group; filter(); });
        get("zoo-dimensions").append(button);
      }
      get("zoo-query").disabled = get("zoo-label").disabled = false;
      get("zoo-query").addEventListener("input", search);
      get("zoo-label").addEventListener("change", () => filter());
      get("zoo-prev").addEventListener("click", () => { page--; renderPage(); });
      get("zoo-next").addEventListener("click", () => { page++; renderPage(); });
      followAddress();
      window.addEventListener("popstate", followAddress);
    } catch (error) {
      get("zoo-feedback").append(el("p", "error", error.message), action("Retry catalogue", init));
    } finally {
      get("zoo-loading").hidden = true;
    }
  }

  bindSearchHelp();
  init();
})();
