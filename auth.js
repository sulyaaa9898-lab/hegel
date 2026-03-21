(function () {
  function ensureRootAdmin(state, config, storage) {
    if (!state.admins.some(a => a.login === config.root.login)) {
      state.admins.push({
        login: config.root.login,
        password: config.root.password,
        name: config.root.name,
        created: new Date().toISOString(),
        isRoot: true
      });
      storage.saveAdmins(state);
    }
  }

  window.AuthModule = {
    ensureRootAdmin
  };
})();
