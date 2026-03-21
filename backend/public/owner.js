(function () {
	const COUNT_MODE_SET = 'SET_COUNT';
	const COUNT_MODE_SKIP = 'SKIP';

	const TOKEN_KEY = 'saas_owner_token';
	const ADMIN_KEY = 'saas_owner_admin';

	const state = {
		token: '',
		admin: null,
		clubs: [],
		selectedClub: null,
		hasAppliedLinks: false
	};

	const els = {
		ownerStatus:       document.getElementById('ownerStatus'),
		authView:          document.getElementById('authView'),
		ownerView:         document.getElementById('ownerView'),
		login:             document.getElementById('login'),
		password:          document.getElementById('password'),
		loginBtn:          document.getElementById('loginBtn'),
		refreshBtn:        document.getElementById('refreshBtn'),
		logoutBtn:         document.getElementById('logoutBtn'),
		clubName:          document.getElementById('clubName'),
		clubType:          document.getElementById('clubType'),
		clubSlug:          document.getElementById('clubSlug'),
		clubSubscriptionType: document.getElementById('clubSubscriptionType'),
		clubTrialDays:     document.getElementById('clubTrialDays'),
		trialDaysWrap:     document.getElementById('trialDaysWrap'),
		createClubBtn:     document.getElementById('createClubBtn'),
		clubsList:         document.getElementById('clubsList'),
		selectedTitle:     document.getElementById('selectedTitle'),
		selectedHint:      document.getElementById('selectedHint'),
		configBlock:       document.getElementById('configBlock'),
		pcCountMode:       document.getElementById('pcCountMode'),
		pcCount:           document.getElementById('pcCount'),
		psCountMode:       document.getElementById('psCountMode'),
		psCount:           document.getElementById('psCount'),
		groupsContainer:   document.getElementById('groupsContainer'),
		addGroupBtn:       document.getElementById('addGroupBtn'),
		psAssignmentsBody: document.getElementById('psAssignmentsBody'),
		psAssignmentsHint: document.getElementById('psAssignmentsHint'),
		applyConfigBtn:    document.getElementById('applyConfigBtn'),
		appliedLinksBlock: document.getElementById('appliedLinksBlock'),
		appliedClubLink:   document.getElementById('appliedClubLink'),
		appliedOwnerInviteLink: document.getElementById('appliedOwnerInviteLink'),
		copyAppliedClubLinkBtn: document.getElementById('copyAppliedClubLinkBtn'),
		copyAppliedOwnerInviteBtn: document.getElementById('copyAppliedOwnerInviteBtn'),
		regenerateOwnerInviteBtn: document.getElementById('regenerateOwnerInviteBtn'),
		resetOwnerAccessBtn: document.getElementById('resetOwnerAccessBtn'),
		ownerResult:       document.getElementById('ownerResult'),
		enableBtn:         document.getElementById('enableBtn'),
		disableBtn:        document.getElementById('disableBtn'),
		deleteClubBtn:     document.getElementById('deleteClubBtn'),
		subSelect:         document.getElementById('subSelect'),
		renewTrialDays:    document.getElementById('renewTrialDays'),
		updateSubBtn:      document.getElementById('updateSubBtn')
	};

	function resetAppliedLinks() {
		state.hasAppliedLinks = false;
		if (els.appliedClubLink) els.appliedClubLink.value = '';
		if (els.appliedOwnerInviteLink) els.appliedOwnerInviteLink.value = '';
		els.appliedLinksBlock.classList.add('hidden');
	}

	function setAppliedLinks(clubLink, ownerInviteLink) {
		state.hasAppliedLinks = true;
		if (els.appliedClubLink) els.appliedClubLink.value = clubLink || '';
		if (els.appliedOwnerInviteLink) els.appliedOwnerInviteLink.value = ownerInviteLink || '';
		els.appliedLinksBlock.classList.remove('hidden');
	}

	function setStatus(msg) {
		if (els && els.ownerResult) {
			els.ownerResult.textContent = msg;
		} else {
			const el = document.getElementById('ownerResult');
			if (el) el.textContent = msg;
		}
	}

	function isTrialType(value) {
		return String(value || '').trim().toLowerCase() === 'trial';
	}

	function syncSubscriptionInputs() {
		const createTrial = isTrialType(els.clubSubscriptionType.value);
		els.trialDaysWrap.style.display = createTrial ? '' : 'none';

		const renewTrial = isTrialType(els.subSelect.value);
		els.renewTrialDays.style.display = renewTrial ? '' : 'none';
	}

	function formatSubscriptionLine(club) {
		const status = String(club.subscription_status || 'active');
		const daysLeft = Number(club.subscription_days_left || 0);
		const type = String(club.subscription_type || 'monthly');
		const expiresAt = club.subscription_expires_at ? new Date(club.subscription_expires_at) : null;
		const expiresText = expiresAt && !Number.isNaN(expiresAt.getTime())
			? expiresAt.toLocaleDateString('ru-RU')
			: '—';

		if (status === 'expired') {
			return { text: `Подписка: ${type} · истекла · до ${expiresText}`, className: 'sub-status-expired' };
		}
		if (status === 'expiring') {
			return { text: `Подписка: ${type} · осталось ${daysLeft} дн. · до ${expiresText}`, className: 'sub-status-expiring' };
		}
		return { text: `Подписка: ${type} · осталось ${daysLeft} дн. · до ${expiresText}`, className: 'sub-status-active' };
	}

	function jsonHeaders() {
		const h = { 'Content-Type': 'application/json' };
		if (state.token) h.Authorization = `Bearer ${state.token}`;
		return h;
	}

	function parseApiPayload(text) {
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch (_) {
			return text;
		}
	}

	function createApiError(response, data) {
		const message = data && typeof data === 'object' && data.error
			? data.error
			: `HTTP ${response.status}`;
		const error = new Error(message);
		error.status = response.status;
		error.code = data && typeof data === 'object' ? data.code : null;
		error.payload = data;
		return error;
	}

	async function api(path, options) {
		const res = await fetch(path, options || {});
		const text = await res.text();
		const data = parseApiPayload(text);
		if (!res.ok) throw createApiError(res, data);
		return data;
	}

	function persistSession() {
		sessionStorage.setItem(TOKEN_KEY, state.token || '');
		sessionStorage.setItem(ADMIN_KEY, state.admin ? JSON.stringify(state.admin) : '');
	}

	function restoreSession() {
		state.token = sessionStorage.getItem(TOKEN_KEY) || '';
		const raw = sessionStorage.getItem(ADMIN_KEY);
		state.admin = raw ? JSON.parse(raw) : null;
	}

	function clearSession() {
		state.token = '';
		state.admin = null;
		sessionStorage.removeItem(TOKEN_KEY);
		sessionStorage.removeItem(ADMIN_KEY);
	}

	function toSlug(val) {
		return String(val || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	}

	function normalizeCountMode(value) {
		return value === COUNT_MODE_SKIP ? COUNT_MODE_SKIP : COUNT_MODE_SET;
	}

	function getDesiredPcCount() {
		if (normalizeCountMode(els.pcCountMode.value) !== COUNT_MODE_SET) return null;
		return Math.max(0, Number(els.pcCount.value || 0));
	}

	function getDesiredPsCount() {
		if (normalizeCountMode(els.psCountMode.value) !== COUNT_MODE_SET) return null;
		return Math.max(0, Number(els.psCount.value || 0));
	}

	function syncCountModeUI() {
		const pcMode = normalizeCountMode(els.pcCountMode.value);
		const psMode = normalizeCountMode(els.psCountMode.value);

		els.pcCount.disabled = pcMode !== COUNT_MODE_SET;
		els.psCount.disabled = psMode !== COUNT_MODE_SET;

		rebuildAssignments();
	}

	function renderAuth() {
		const ok = Boolean(state.token && state.admin && state.admin.role === 'SUPER_ADMIN');
		els.authView.classList.toggle('hidden', ok);
		els.ownerView.classList.toggle('hidden', !ok);
		els.ownerStatus.textContent = ok ? `Вход: ${state.admin.login} (SUPER_ADMIN)` : 'Войдите как SUPER_ADMIN';
	}

	function getGroupNames() {
		return Array.from(els.groupsContainer.children)
			.map((card) => card.querySelector('[data-gk="name"]').value.trim())
			.filter(Boolean);
	}

	function addPackage(pkgList, pkg) {
		const row = document.createElement('div');
		row.className = 'package-row';
		row.innerHTML = `
			<input data-pk="name" type="text" placeholder="Название пакета" value="${pkg.name || ''}">
			<input data-pk="price" type="number" min="0" placeholder="Цена" value="${pkg.price || ''}">
			<input data-pk="duration" type="number" min="1" placeholder="Минуты" value="${pkg.duration_minutes || ''}">
			<button class="btn-bad" data-pk="remove" type="button" title="Удалить пакет">✕</button>
		`;
		row.querySelector('[data-pk="remove"]').addEventListener('click', () => row.remove());
		pkgList.appendChild(row);
	}

	function rebuildAssignmentSelects() {
		const names = getGroupNames();
		document.querySelectorAll('#psAssignmentsBody select[data-ps]').forEach((sel) => {
			const cur = sel.value;
			sel.innerHTML = '<option value="">— не задана —</option>' +
				names.map((g) => `<option${g === cur ? ' selected' : ''} value="${g}">${g}</option>`).join('');
		});
	}

	function getCurrentAssignmentValues() {
		const values = [];
		document.querySelectorAll('#psAssignmentsBody select[data-ps]').forEach((sel) => {
			const psIndex = Number(sel.getAttribute('data-ps') || 0);
			if (psIndex > 0) {
				values[psIndex - 1] = sel.value || '';
			}
		});
		return values;
	}

	function rebuildAssignments(existingDevices) {
		const desiredCount = getDesiredPsCount();
		const count = desiredCount === null ? 0 : desiredCount;
		const names = getGroupNames();
		const currentAssignments = getCurrentAssignmentValues();
		const tbody = els.psAssignmentsBody;
		tbody.innerHTML = '';

		if (count === 0) {
			els.psAssignmentsHint.textContent = normalizeCountMode(els.psCountMode.value) === COUNT_MODE_SKIP
				? 'Количество PS не задано (режим: Не указывать количество).'
				: 'Укажите количество PS выше.';
			return;
		}
		els.psAssignmentsHint.textContent = '';

		for (let i = 1; i <= count; i += 1) {
			const code = `PS-${String(i).padStart(2, '0')}`;
			const existingGroup = existingDevices && existingDevices[i - 1]
				? (existingDevices[i - 1].tariff_group || '')
				: (currentAssignments[i - 1] || '');
			const opts = '<option value="">— не задана —</option>' +
				names.map((g) => `<option${g === existingGroup ? ' selected' : ''} value="${g}">${g}</option>`).join('');
			const tr = document.createElement('tr');
			tr.innerHTML = `<td><strong>${code}</strong></td><td><select data-ps="${i}">${opts}</select></td>`;
			tbody.appendChild(tr);
		}
	}

	function addGroup(groupData) {
		groupData = groupData || {};
		const card = document.createElement('div');
		card.className = 'group-card';
		card.innerHTML = `
			<div class="group-header">
				<div class="split-2" style="flex:1;">
					<div class="field-group" style="margin-bottom:0;">
						<label class="field-label">Название группы</label>
						<input data-gk="name" type="text" placeholder="Standard, VIP..." value="${groupData.name || ''}">
					</div>
					<div class="field-group" style="margin-bottom:0;">
						<label class="field-label">Почасовая цена (₸)</label>
						<input data-gk="hourly" type="number" min="0" placeholder="0" value="${groupData.hourlyPrice || ''}">
					</div>
				</div>
				<button class="btn-bad" data-gk="remove" type="button" style="margin-top:20px;white-space:nowrap;">🗑 Группу</button>
			</div>
			<div class="field-label" style="margin-bottom:4px;">Пакеты</div>
			<div class="packages-list" data-gk="packages"></div>
			<button class="btn-soft" data-gk="addPkg" type="button" style="font-size:0.85rem;padding:6px 10px;">+ Пакет</button>
		`;

		const pkgList = card.querySelector('[data-gk="packages"]');
		(groupData.packages || []).forEach((p) => addPackage(pkgList, p));

		card.querySelector('[data-gk="name"]').addEventListener('input', rebuildAssignmentSelects);
		card.querySelector('[data-gk="remove"]').addEventListener('click', () => {
			card.remove();
			rebuildAssignmentSelects();
		});
		card.querySelector('[data-gk="addPkg"]').addEventListener('click', () => addPackage(pkgList, {}));

		els.groupsContainer.appendChild(card);
		rebuildAssignmentSelects();
	}

	function collectGroups() {
		return Array.from(els.groupsContainer.children).map((card) => {
			const name = card.querySelector('[data-gk="name"]').value.trim();
			const hourlyPrice = Number(card.querySelector('[data-gk="hourly"]').value || 0);
			const packages = Array.from(card.querySelector('[data-gk="packages"]').children).map((row) => ({
				name: row.querySelector('[data-pk="name"]').value.trim(),
				price: Number(row.querySelector('[data-pk="price"]').value || 0),
				duration_minutes: Number(row.querySelector('[data-pk="duration"]').value || 0)
			})).filter((p) => p.name && p.price > 0 && p.duration_minutes > 0);
			return { name, hourlyPrice, packages };
		}).filter((g) => g.name);
	}

	function collectAssignments() {
		return Array.from(document.querySelectorAll('#psAssignmentsBody select[data-ps]')).map((sel) => sel.value || null);
	}

	function renderClubs() {
		const selectedId = state.selectedClub ? state.selectedClub.id : null;
		els.clubsList.innerHTML = '';
		state.clubs.filter((club) => club.slug !== 'default-club').forEach((club) => {
			const box = document.createElement('div');
			box.className = `club${selectedId === club.id ? ' active' : ''}`;
			const tags = [club.subscription_status, club.is_enabled ? '✅' : '⛔', club.is_configured ? 'настроен' : 'не настроен'].join(' | ');
			const sub = formatSubscriptionLine(club);
			box.innerHTML = `
				<div><strong>${club.name}</strong> <span class="badge">${club.slug}</span></div>
				${club.club_type ? `<div class="muted" style="font-size:0.82rem;">${club.club_type}</div>` : ''}
				<div class="${sub.className}" style="font-size:0.82rem;">${sub.text}</div>
				<div class="muted">${tags}</div>
				<div class="row"><button class="btn-soft" type="button">Выбрать</button></div>
			`;
			box.querySelector('button').addEventListener('click', () => selectClub(club.id));
			els.clubsList.appendChild(box);
		});
	}

	async function loadClubs() {
		state.clubs = await api('/api/owner/clubs', { method: 'GET', headers: jsonHeaders() });
		renderClubs();
	}

	async function selectClub(clubId) {
		try {
			const details = await api(`/api/owner/clubs/${clubId}`, { method: 'GET', headers: jsonHeaders() });
			state.selectedClub = details;
			renderClubs();

			els.configBlock.classList.remove('hidden');
			els.selectedTitle.textContent = details.name;
			const typeStr = details.club_type ? ` · ${details.club_type}` : '';
			const subHint = details.subscription_notice || `Подписка: ${details.subscription_status} (${details.subscription_days_left || 0} дн.)`;
			els.selectedHint.textContent = `/${details.slug}${typeStr}  —  ${details.local_link} · ${subHint}`;
			setAppliedLinks(details.local_link || '', details.owner_invite_link || '');
			els.subSelect.value = details.subscription_type || 'monthly';
			syncSubscriptionInputs();

			const devices = (details.config && details.config.devices) ? details.config.devices : [];
			const tariffs = (details.config && details.config.tariffs) ? details.config.tariffs : [];
			const applyOptions = details.config && details.config.apply_options ? details.config.apply_options : null;

			const pcDevices = devices.filter((d) => d.device_type === 'PC' && d.is_active);
			const psDevices = devices.filter((d) => d.device_type === 'PS' && d.is_active);

			els.pcCountMode.value = normalizeCountMode(applyOptions && applyOptions.pc_mode ? applyOptions.pc_mode : (pcDevices.length > 0 ? COUNT_MODE_SET : COUNT_MODE_SKIP));
			els.psCountMode.value = normalizeCountMode(applyOptions && applyOptions.ps_mode ? applyOptions.ps_mode : (psDevices.length > 0 ? COUNT_MODE_SET : COUNT_MODE_SKIP));
			els.pcCount.value = String(pcDevices.length);
			els.psCount.value = String(psDevices.length);
			syncCountModeUI();

			els.groupsContainer.innerHTML = '';
			const psTariffs = tariffs.filter((t) => t.device_type === 'PS' && t.is_active);
			const groupMap = {};
			psTariffs.forEach((t) => {
				const key = t.applies_to_value || '__ALL__';
				if (!groupMap[key]) {
					groupMap[key] = { name: key === '__ALL__' ? 'Standard' : key, hourlyPrice: 0, packages: [] };
				}
				if (t.billing_type === 'hourly') groupMap[key].hourlyPrice = t.price;
				else groupMap[key].packages.push({ name: t.tariff_name, price: t.price, duration_minutes: t.duration_minutes });
			});

			const groupList = Object.values(groupMap);
			if (groupList.length === 0) addGroup({ name: 'Standard', hourlyPrice: 0, packages: [] });
			else groupList.forEach((g) => addGroup(g));

			rebuildAssignments(psDevices);
		} catch (err) {
			setStatus(err.message);
		}
	}

	async function createClub() {
		try {
			const name = els.clubName.value.trim();
			if (!name) throw new Error('Укажите название клуба');
			const payload = {
				name,
				club_type: els.clubType.value.trim() || null,
				slug: toSlug(els.clubSlug.value.trim() || name),
				subscription_type: els.clubSubscriptionType.value,
				trial_days: isTrialType(els.clubSubscriptionType.value) ? Number(els.clubTrialDays.value || 7) : null
			};
			const created = await api('/api/owner/clubs', {
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(payload)
			});
			els.clubName.value = '';
			els.clubType.value = '';
			els.clubSlug.value = '';
			resetAppliedLinks();
			await loadClubs();
			await selectClub(created.id);
			if (created.reused) {
				setStatus(`Клуб уже существовал: ${created.slug}. ${created.owner_invite_link ? 'Сформирована invite-ссылка владельца.' : 'Владелец уже активирован.'}`);
			} else {
				setStatus(`Клуб создан: ${created.slug}. Настройте и примените конфигурацию клуба.`);
			}
		} catch (err) {
			setStatus(err.message);
		}
	}

	async function applyConfig() {
		if (!state.selectedClub) return;
		try {
			const pcMode = normalizeCountMode(els.pcCountMode.value);
			const psMode = normalizeCountMode(els.psCountMode.value);
			const pcCount = getDesiredPcCount();
			const psCount = getDesiredPsCount();
			const groups = collectGroups();
			const assignments = collectAssignments();

			if (pcMode === COUNT_MODE_SET && (!Number.isFinite(pcCount) || pcCount <= 0)) {
				throw new Error('Количество ПК / PS должно быть больше 0 или выберите "Не указывать количество"');
			}

			if (psMode === COUNT_MODE_SET && (!Number.isFinite(psCount) || psCount <= 0)) {
				throw new Error('Количество ПК / PS должно быть больше 0 или выберите "Не указывать количество"');
			}

			if (psMode === COUNT_MODE_SET && psCount > 0 && groups.length === 0) {
				throw new Error('Добавьте минимум одну тарифную группу для PS');
			}

			const psTariffs = [];
			if (psMode === COUNT_MODE_SET) {
				groups.forEach((group) => {
					if (group.hourlyPrice > 0) {
						psTariffs.push({ tariff_name: 'Почасовой', billing_type: 'hourly', price: group.hourlyPrice, applies_to_type: 'GROUP', applies_to_value: group.name });
					}
					group.packages.forEach((pkg) => {
						psTariffs.push({
							tariff_name: pkg.name,
							billing_type: 'package',
							price: pkg.price,
							duration_minutes: pkg.duration_minutes,
							applies_to_type: 'GROUP',
							applies_to_value: group.name
						});
					});
				});
			}

			const payload = {
				pc_mode: pcMode,
				ps_mode: psMode,
				pc_count: pcMode === COUNT_MODE_SET ? pcCount : null,
				ps_count: psMode === COUNT_MODE_SET ? psCount : null,
				ps_assignments: psMode === COUNT_MODE_SET ? assignments : [],
				tariffs: { pc: [], ps: psTariffs }
			};

			const result = await api(`/api/owner/clubs/${state.selectedClub.id}/config/apply`, {
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(payload)
			});

			await selectClub(state.selectedClub.id);
			await loadClubs();
			setAppliedLinks(result.local_link || '', result.owner_invite_link || '');
			setStatus('Конфигурация успешно применена.');
		} catch (err) {
			setStatus(err.message);
		}
	}

	async function updateEnable(enabled) {
		if (!state.selectedClub) return;
		try {
			await api(`/api/owner/clubs/${state.selectedClub.id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST', headers: jsonHeaders() });
			await selectClub(state.selectedClub.id);
			await loadClubs();
			setStatus(`Клуб ${enabled ? 'включён' : 'отключён'}.`);
		} catch (err) {
			setStatus(err.message);
		}
	}

	async function updateSubscription() {
		if (!state.selectedClub) return;
		try {
			const selected = String(els.subSelect.value || '').trim().toLowerCase();
			const payload = selected === 'expired'
				? { subscription_status: 'expired' }
				: {
					subscription_type: selected,
					trial_days: isTrialType(selected) ? Number(els.renewTrialDays.value || 7) : null,
					months: isTrialType(selected) ? null : 1
				};

			await api(`/api/owner/clubs/${state.selectedClub.id}/subscription`, {
				method: 'POST',
				headers: jsonHeaders(),
				body: JSON.stringify(payload)
			});
			await selectClub(state.selectedClub.id);
			await loadClubs();
			setStatus(selected === 'expired' ? 'Подписка принудительно помечена как истекшая.' : 'Подписка продлена.');
		} catch (err) {
			setStatus(err.message);
		}
	}

	async function deleteSelectedClub() {
		if (!state.selectedClub) return;
		const target = state.selectedClub;
		if (!window.confirm(`Удалить клуб "${target.name}" (${target.slug})?`)) return;
		try {
			await api(`/api/owner/clubs/${target.id}`, { method: 'DELETE', headers: jsonHeaders() });
			state.selectedClub = null;
			els.configBlock.classList.add('hidden');
			els.selectedTitle.textContent = 'Конфигурация Клуба';
			els.selectedHint.textContent = 'Выберите клуб слева, чтобы настроить его.';
			await loadClubs();
			setStatus(`Клуб удалён: ${target.slug}`);
		} catch (err) {
			setStatus(err.message);
		}
	}

	function copyText(value, emptyMessage) {
		const url = String(value || '').trim();
		if (!url) {
			if (emptyMessage) setStatus(emptyMessage);
			return;
		}
		
		// Проверяем, использует ли страница HTTPS или localhost
		const isSecure = window.isSecureContext;
		
		if (navigator.clipboard && navigator.clipboard.writeText && isSecure) {
			// Используем clipboard API если доступно и безопасный контекст
			navigator.clipboard.writeText(url).then(
				() => setStatus(`✅ Скопировано: ${url}`),
				(err) => {
					console.error('Clipboard API error:', err);
					// Fallback на старый метод
					copyTextFallback(url);
					setStatus(`Ссылка скопирована (режим fallback): ${url}`);
				}
			);
		} else {
			// Используем fallback для HTTP или старых браузеров
			copyTextFallback(url);
			if (!isSecure && !window.location.hostname.includes('localhost')) {
				setStatus(`✅ Скопировано (режим fallback, т.к. используется HTTP): ${url}`);
			} else {
				setStatus(`✅ Скопировано: ${url}`);
			}
		}
	}
	
	function copyTextFallback(url) {
		const textarea = document.createElement('textarea');
		textarea.value = url;
		textarea.style.position = 'fixed';
		textarea.style.opacity = '0';
		document.body.appendChild(textarea);
		textarea.select();
		try {
			document.execCommand('copy');
		} catch (err) {
			console.error('Fallback copy error:', err);
		}
		document.body.removeChild(textarea);
	}

	function copyAppliedClubLink() {
		const input = document.getElementById('appliedClubLink');
		if (!input) {
			console.error('appliedClubLink element not found in DOM');
			return;
		}
		copyText(input.value, 'Ссылка клуба пока недоступна. Примените конфигурацию клуба.');
	}

	function copyAppliedOwnerInvite() {
		const input = document.getElementById('appliedOwnerInviteLink');
		if (!input) {
			console.error('appliedOwnerInviteLink element not found in DOM');
			return;
		}
		copyText(input.value, 'Owner invite link недоступна. Возможно, владелец уже активирован.');
	}

	async function regenerateOwnerInvite() {
		if (!state.selectedClub) return;
		try {
			const result = await api(`/api/owner/clubs/${state.selectedClub.id}/owner-invite/regenerate`, {
				method: 'POST',
				headers: jsonHeaders()
			});
			setAppliedLinks(result.club_link || state.selectedClub.local_link || '', result.owner_invite_link || '');
			setStatus('Новая invite-ссылка создана. Предыдущая ссылка аннулирована.');

			async function resetOwnerAccess() {
				if (!state.selectedClub) return;
		
				const confirmed = confirm(
					'⚠️ ВНИМАНИЕ!\n\n' +
					'Это действие полностью сбросит доступ текущего владельца клуба:\n' +
					'• Старый логин/пароль больше не будут работать\n' +
					'• Все сессии будут отозваны\n' +
					'• Старая invite-ссылка станет недействительной\n' +
					'• Будет сгенерирована новая invite-ссылка\n\n' +
					'Владелец сможет активировать новый доступ с помощью новой ссылки.\n\n' +
					'Продолжить?'
				);
		
				if (!confirmed) return;
		
				try {
					setStatus('Выполняю сброс доступа владельца...');
					const result = await api(`/api/owner/clubs/${state.selectedClub.id}/owner-access/reset`, {
						method: 'POST',
						headers: jsonHeaders()
					});
			
					setAppliedLinks(result.club_link || state.selectedClub.local_link || '', result.new_invite_link || '');
					setStatus('✅ ' + (result.message || 'Доступ владельца успешно сброшен! Новая invite-ссылка создана.'));
				} catch (err) {
					setStatus('❌ Ошибка при сбросе доступа: ' + (err.message || 'Неизвестная ошибка'));
				}
			}
		} catch (err) {
			setStatus(err.message);
		}
	}

	async function login() {
		try {
			const data = await api('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ login: els.login.value.trim(), password: els.password.value })
			});
			if (!data.admin || data.admin.role !== 'SUPER_ADMIN') throw new Error('Этот аккаунт не является SUPER_ADMIN');
			state.token = data.token;
			state.admin = data.admin;
			persistSession();
			renderAuth();
			await loadClubs();
			setStatus('Вход выполнен.');
		} catch (err) {
			setStatus(err.message);
		}
	}

	function logout() {
		clearSession();
		state.selectedClub = null;
		resetAppliedLinks();
		state.clubs = [];
		renderAuth();
		renderClubs();
		els.configBlock.classList.add('hidden');
		setStatus('Выход выполнен.');
	}

	async function refreshAll() {
		if (!state.token) return;
		try {
			await loadClubs();
			if (state.selectedClub) await selectClub(state.selectedClub.id);
			setStatus('Данные обновлены.');
		} catch (err) {
			setStatus(err.message);
		}
	}

	function bind() {
		els.loginBtn.addEventListener('click', login);
		els.logoutBtn.addEventListener('click', logout);
		els.refreshBtn.addEventListener('click', refreshAll);
		els.createClubBtn.addEventListener('click', createClub);
		els.clubSubscriptionType.addEventListener('change', syncSubscriptionInputs);
		els.pcCountMode.addEventListener('change', syncCountModeUI);
		els.psCountMode.addEventListener('change', syncCountModeUI);
		els.addGroupBtn.addEventListener('click', () => addGroup({ name: '', hourlyPrice: 0, packages: [] }));
		els.psCount.addEventListener('input', () => rebuildAssignments());
		els.applyConfigBtn.addEventListener('click', applyConfig);
		els.copyAppliedClubLinkBtn.addEventListener('click', copyAppliedClubLink);
		els.copyAppliedOwnerInviteBtn.addEventListener('click', copyAppliedOwnerInvite);
		els.regenerateOwnerInviteBtn.addEventListener('click', regenerateOwnerInvite);
		els.resetOwnerAccessBtn.addEventListener('click', resetOwnerAccess);
		els.enableBtn.addEventListener('click', () => updateEnable(true));
		els.disableBtn.addEventListener('click', () => updateEnable(false));
		els.deleteClubBtn.addEventListener('click', deleteSelectedClub);
		els.subSelect.addEventListener('change', syncSubscriptionInputs);
		els.updateSubBtn.addEventListener('click', updateSubscription);
	}

	async function init() {
		console.log('🔧 Initializing owner panel...');
		console.log('Protocol:', window.location.protocol);
		console.log('Secure context:', window.isSecureContext);
		console.log('Available elements:', {
			appliedClubLink: !!els.appliedClubLink,
			copyAppliedClubLinkBtn: !!els.copyAppliedClubLinkBtn,
			appliedOwnerInviteLink: !!els.appliedOwnerInviteLink,
			ownerResult: !!els.ownerResult
		});
		
		if (!window.isSecureContext && window.location.protocol === 'http:') {
			console.warn('⚠️ Page is using HTTP (not HTTPS). Clipboard API will use fallback method.');
		}
		
		bind();
		syncCountModeUI();
		syncSubscriptionInputs();
		restoreSession();
		renderAuth();
		if (state.token && state.admin && state.admin.role === 'SUPER_ADMIN') {
			try {
				await loadClubs();
				setStatus('Сессия восстановлена.');
			} catch (err) {
				setStatus(err.message);
			}
		}
	}

	init();
})();