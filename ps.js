(function () {
  function normalizeGroupName(value) {
    const normalized = String(value || '').trim();
    return normalized || null;
  }

  function readRuntimeGroup(psID, runtimeConfig) {
    if (!runtimeConfig || typeof runtimeConfig !== 'object') return null;

    const consoleToGroup = runtimeConfig.consoleToGroup;
    const groupsByName = runtimeConfig.groupsByName;
    if (!(consoleToGroup instanceof Map) || !(groupsByName instanceof Map)) return null;

    const groupName = normalizeGroupName(consoleToGroup.get(Number(psID)));
    if (!groupName) return null;
    return groupsByName.get(groupName) || null;
  }

  function getPSGroup(psID, runtimeConfig) {
    const group = readRuntimeGroup(psID, runtimeConfig);
    return group ? group.name : null;
  }

  function getTariff(psID, runtimeConfig) {
    const group = readRuntimeGroup(psID, runtimeConfig);
    const hourlyPrice = Number(group && group.hourly_price);
    return Number.isFinite(hourlyPrice) && hourlyPrice > 0 ? hourlyPrice : 0;
  }

  function getPerMinRate(psID, runtimeConfig) {
    const hourlyTariff = getTariff(psID, runtimeConfig);
    return hourlyTariff > 0 ? hourlyTariff / 60 : 0;
  }

  function createDefaultConsoles(config) {
    const count = Number((config && config.ps && config.ps.defaultConsoleCount) || 0);
    const consoles = [];
    for (let i = 1; i <= count; i += 1) {
      consoles.push({
        id: i,
        status: 'idle',
        remaining: 0,
        startTime: 0,
        prepaid: 0,
        totalPaid: 0,
        selectedPackage: null,
        addedTime: 0,
        clientName: null,
        clientPhone: null,
        booking: null,
        isFreeTime: false
      });
    }
    return consoles;
  }

  function getPackageGroup(psID, runtimeConfig) {
    const group = readRuntimeGroup(psID, runtimeConfig);
    const packages = group && Array.isArray(group.packages) ? group.packages : [];
    return packages
      .map((pkg) => ({
        name: String(pkg.name || '').trim(),
        price: Number(pkg.price || 0),
        duration_minutes: Number(pkg.duration_minutes || 0)
      }))
      .filter((pkg) => pkg.name && pkg.price > 0 && pkg.duration_minutes > 0);
  }

  window.PSModule = {
    getPSGroup,
    getTariff,
    getPerMinRate,
    createDefaultConsoles,
    getPackageGroup
  };
})();
