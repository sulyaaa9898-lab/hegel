(function () {
  window.AppState = {
    currentPlatform: 'pc',
    bookings: [],
    done: [],
    guestRatings: {},
    currentBookingIndex: null,
    pendingForce: null,
    currentAdmin: null,
    admins: [],
    psConsoles: [],
    currentPSID: 0,
    psTimerInterval: null,
    currentEditPCBookingIndex: null,
    currentEditPSID: null,
    today: new Date()
  };
})();
