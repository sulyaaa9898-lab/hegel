(function () {
  let notifyModal = null;
  let notifyTitle = null;
  let notifyMessage = null;
  let notifyCancel = null;
  let notifyOk = null;
  let notifyConfirmHandler = null;

  function ensureNotifyModal() {
    if (notifyModal) return;

    notifyModal = document.createElement('div');
    notifyModal.id = 'appNotifyModal';
    notifyModal.className = 'modal';
    notifyModal.style.display = 'none';

    const content = document.createElement('div');
    content.className = 'modal-content';

    notifyTitle = document.createElement('h3');
    notifyTitle.id = 'appNotifyTitle';

    notifyMessage = document.createElement('p');
    notifyMessage.id = 'appNotifyMessage';

    const buttons = document.createElement('div');
    buttons.className = 'modal-buttons';
    buttons.style.flexDirection = 'row';

    notifyCancel = document.createElement('button');
    notifyCancel.type = 'button';
    notifyCancel.textContent = 'Отмена';
    notifyCancel.addEventListener('click', () => closeNotify());

    notifyOk = document.createElement('button');
    notifyOk.type = 'button';
    notifyOk.textContent = 'OK';
    notifyOk.addEventListener('click', () => {
      const handler = notifyConfirmHandler;
      closeNotify();
      if (typeof handler === 'function') handler();
    });

    buttons.appendChild(notifyCancel);
    buttons.appendChild(notifyOk);
    content.appendChild(notifyTitle);
    content.appendChild(notifyMessage);
    content.appendChild(buttons);
    notifyModal.appendChild(content);

    notifyModal.addEventListener('click', (e) => {
      if (e.target === notifyModal) closeNotify();
    });

    document.body.appendChild(notifyModal);
  }

  function closeNotify() {
    ensureNotifyModal();
    notifyConfirmHandler = null;
    notifyModal.style.display = 'none';
  }

  function showAlert(message, title = 'Уведомление') {
    ensureNotifyModal();
    notifyTitle.textContent = title;
    notifyMessage.textContent = message;
    notifyConfirmHandler = null;
    notifyCancel.style.display = 'none';
    notifyOk.textContent = 'OK';
    notifyModal.style.display = 'flex';
  }

  function showConfirm(message, onConfirm, title = 'Подтвердите действие') {
    ensureNotifyModal();
    notifyTitle.textContent = title;
    notifyMessage.textContent = message;
    notifyConfirmHandler = onConfirm;
    notifyCancel.style.display = 'inline-block';
    notifyOk.textContent = 'Подтвердить';
    notifyModal.style.display = 'flex';
  }

  function toggleElement(id, visible) {
    const element = document.getElementById(id);
    if (!element) return;
    element.style.display = visible ? 'flex' : 'none';
  }

  function bindRuPhoneInput(inputElement, cleanPhone, formatPhone) {
    if (!inputElement) return;
    inputElement.addEventListener('focus', () => {
      if (!inputElement.value.startsWith('+7')) inputElement.value = '+7 ';
      setTimeout(() => inputElement.setSelectionRange(inputElement.value.length, inputElement.value.length), 0);
    });
    inputElement.addEventListener('input', function () {
      const digits = cleanPhone(this.value);
      this.value = formatPhone(digits);
    });
  }

  window.UIModule = {
    showAlert,
    showConfirm,
    closeNotify,
    toggleElement,
    bindRuPhoneInput
  };
})();
