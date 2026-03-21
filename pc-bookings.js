(function () {
  function normalizeName(name) {
    const value = (name || '').trim();
    if (!value) return '';
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function parsePcList(input) {
    return (input || '').trim().split(/[\s,]+/).map(p => p.trim()).filter(Boolean);
  }

  function isValidPcList(pcs, maxPCs) {
    return pcs.every(p => /^\d{1,2}$/.test(p) && +p >= 1 && +p <= maxPCs);
  }

  function parseTimeHHMM(raw) {
    const value = (raw || '').trim();
    if (!/^\d{4}$/.test(value)) return null;
    const hours = parseInt(value.slice(0, 2), 10);
    const minutes = parseInt(value.slice(2), 10);
    if (hours > 23 || minutes > 59) return null;
    return `${value.slice(0, 2)}:${value.slice(2)}`;
  }

  window.PCBookingsModule = {
    normalizeName,
    parsePcList,
    isValidPcList,
    parseTimeHHMM
  };
})();
