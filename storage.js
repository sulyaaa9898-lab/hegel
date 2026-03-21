(function () {
  const LEGACY_KEYS = [
    'bookings',
    'done',
    'guestRatings',
    'cyberAdmins',
    'currentAdmin',
    'psConsolesData',
    'auth_token'
  ];

  function clearLegacyBrowserStorage() {
    try {
      LEGACY_KEYS.forEach((key) => localStorage.removeItem(key));
    } catch (_) {}

    try {
      LEGACY_KEYS.forEach((key) => sessionStorage.removeItem(key));
    } catch (_) {}
  }

  function loadInitialState(state) {
    clearLegacyBrowserStorage();
    state.bookings = [];
    state.done = [];
    state.guestRatings = {};
    state.admins = [];
    state.currentAdmin = null;
    state.psConsoles = [];
  }

  function saveBookingsState(_) {}

  function savePSState(_) {}

  function saveAdmins(_) {}

  function saveCurrentAdmin(_) {}

  window.AppStorage = {
    loadInitialState,
    saveBookingsState,
    savePSState,
    saveAdmins,
    saveCurrentAdmin,
    clearLegacyBrowserStorage
  };
})();
