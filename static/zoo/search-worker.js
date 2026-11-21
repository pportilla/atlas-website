import createKernel from "./zoo-kernel.mjs";

const encoder = new TextEncoder();
function copyString(kernel, text) {
  const bytes = encoder.encode(text);
  const address = kernel._malloc(bytes.length + 1);
  if (!address) throw new Error("Insufficient memory for this catalogue search.");
  kernel.HEAPU8.set(bytes, address);
  kernel.HEAPU8[address + bytes.length] = 0;
  return address;
}

let entries;
let opening;
async function open(entries) {
  const kernel = await createKernel();
  const wire = entries.map(entry => [
    entry.id, ...entry.terms.map(term => [term.coefficient, ...term.exponents].join(" "))
  ].join("\t")).join("\n");
  const pointer = copyString(kernel, wire);
  try {
    const index = kernel._atlas_zoo_create(pointer);
    if (!index) throw new Error(kernel.UTF8ToString(kernel._atlas_zoo_error()));
    return {kernel, index};
  } finally {
    kernel._free(pointer);
  }
}

self.onmessage = async ({data}) => {
  if (data.entries) {
    // Initialize lazily so a failure is reported with the first query.
    entries = data.entries;
    return;
  }
  try {
    opening ??= open(entries).catch(error => {
      opening = undefined;
      throw error;
    });
    const {kernel, index} = await opening;
    if (data.query.includes("\0")) throw new Error("Queries cannot contain a null character.");
    const pointer = copyString(kernel, data.query);
    try {
      const answer = kernel._atlas_zoo_search(index, pointer);
      if (!answer) throw new Error(kernel.UTF8ToString(kernel._atlas_zoo_error()));
      const ids = kernel.UTF8ToString(answer);
      self.postMessage({id: data.id, ids: ids ? ids.split("\n") : []});
    } finally {
      kernel._free(pointer);
    }
  } catch (error) {
    self.postMessage({id: data.id, error: error.message});
  }
};
