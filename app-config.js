(function () {
  window.AppConfig = Object.freeze({
    maxPCs: 75,
    bookingDateHorizonDays: 75,
    doneRetentionHours: 48,
    root: Object.freeze({
      login: 'Algaib',
      password: '61659398',
      name: 'Султан'
    }),
    rating: Object.freeze({
      latePenalty: 5,
      cancelledPenalty: 10,
      noShowPenalty: 15
    }),
    ps: Object.freeze({
      defaultConsoleCount: 9,
      warningMinutes: 5,
      tariffs: Object.freeze({ group1: 1800, group2: 2500, group3: 1200 }),
      perMinRates: Object.freeze({ group1: 30, group2: 42, group3: 20 }),
      packages: Object.freeze({
        1: Object.freeze({ '2+1': Object.freeze({ hours: 3, cost: 3600 }), '3+2': Object.freeze({ hours: 5, cost: 5400 }), 'Кальян': Object.freeze({ hours: 3, cost: 6500 }), 'Пицца': Object.freeze({ hours: 2, cost: 5500 }) }),
        7: Object.freeze({ '2+1': Object.freeze({ hours: 3, cost: 5000 }), '3+2': Object.freeze({ hours: 5, cost: 7500 }), 'Кальян': Object.freeze({ hours: 3, cost: 7000 }), 'Пицца': Object.freeze({ hours: 2, cost: 6500 }) }),
        8: Object.freeze({ '2+1': Object.freeze({ hours: 3, cost: 2400 }), '3+2': Object.freeze({ hours: 5, cost: 3600 }), 'Кальян': Object.freeze({ hours: 3, cost: 6000 }), 'Пицца': Object.freeze({ hours: 2, cost: 5000 }) })
      })
    })
  });
})();
