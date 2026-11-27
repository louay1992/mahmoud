(() => {
  const categories = [
    ['all', 'الكل'], ['unread', 'غير مقروء'], ['orders', 'الطلبات'],
    ['status', 'الحالات'], ['notes', 'الملاحظات'], ['payments', 'الدفعات'], ['prices', 'الأسعار']
  ];
  const categoryByKind = new Map([
    ['new_order', 'orders'], ['order_edit', 'orders'], ['order_removed', 'orders'], ['staff_order', 'orders'],
    ['status', 'status'], ['admin_note', 'notes'], ['captain_note', 'notes'],
    ['payment', 'payments'], ['price_request', 'prices'], ['price_decision', 'prices']
  ]);
  const categoryLabels = new Map(categories);
  const categoryIcons = {orders: 'box', status: 'bell', notes: 'note', payments: 'wallet', prices: 'tag'};
  const amountLabels = ['المطلوب من الزبون', 'المبلغ المسجَّل', 'الإجمالي الجديد', 'الإجمالي', 'يبقى الإجمالي'];
  const previewLabels = ['الشركة', 'رقم البوليصة', 'الزبون', 'الكابتن', 'الحالة الآن', 'الحالة', 'ملاحظة', 'الملاحظة'];
  const number = new Intl.NumberFormat('ar-SY');
  const dayFormat = new Intl.DateTimeFormat('ar-SY', {day: 'numeric', month: 'long', year: 'numeric'});
  const timeFormat = new Intl.DateTimeFormat('ar-SY', {hour: 'numeric', minute: '2-digit'});
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const iconPaths = {
    chevron: '<path d="m6 9 6 6 6-6"/>',
    arrow: '<path d="M19 12H5m7-7-7 7 7 7"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
    note: '<path d="M20 15a2 2 0 0 1-2 2H9l-5 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z"/><path d="M8 9h8m-8 4h5"/>'
  };
  const lineParts = line => /^([^:\n]{1,50}):\s*(.+)$/.exec(line);
  const cleanTitle = title => String(title || '').replace(/^(?:\p{Extended_Pictographic}\uFE0F?\s*)+/u, '');
  const isUnread = (record, owner) => Boolean(owner) && !(record.read_by || []).includes(owner);

  function dateGroup(date, now, yesterday) {
    if (!Number.isFinite(date.getTime())) return ['unknown', 'بدون تاريخ'];
    const key = date.toDateString();
    return [key, key === now ? 'اليوم' : key === yesterday ? 'أمس' : dayFormat.format(date)];
  }

  class DeliveryNotifications {
    constructor(options) {
      this.options = options;
      this.bell = document.getElementById('bell');
      this.scope = 0;
      this.pending = new Set();
      this.filter = 'all';
      this.expanded = '';
      this.markup = '';
      this.dialog = document.createElement('dialog');
      this.dialog.id = 'delivery-notifications';
      this.dialog.setAttribute('aria-labelledby', 'delivery-notifications-title');
      const icon = name => this.icon(name);
      this.dialog.innerHTML = `
        <div class="dn-panel">
          <div class="dn-heading">
            <span class="dn-heading-icon" aria-hidden="true">${icon('bell')}</span>
            <div class="dn-heading-text">
              <h2 id="delivery-notifications-title">الإشعارات</h2>
              <p class="dn-count" aria-live="polite"></p>
            </div>
            <button type="button" class="dn-close" data-dn="close" aria-label="إغلاق الإشعارات" autofocus>${icon('x')}</button>
          </div>
          <div class="dn-toolbar">
            <div class="dn-filters" role="group" aria-label="تصنيف الإشعارات">
              ${categories.map(([key, label]) => `<button type="button" data-dn="filter" data-key="${key}" aria-pressed="false">${label}</button>`).join('')}
            </div>
            <div class="dn-controls">
              <button type="button" data-dn="read-all">${icon('check')}<span>تعليم الكل كمقروء</span></button>
              <button type="button" data-dn="enable">${icon('bell')}<span>تفعيل إشعارات الجهاز</span></button>
            </div>
            <p class="dn-feedback" role="status" hidden></p>
          </div>
          <div class="dn-list" aria-label="قائمة الإشعارات"></div>
        </div>`;
      document.body.append(this.dialog);
      this.list = this.dialog.querySelector('.dn-list');
      this.feedback = this.dialog.querySelector('.dn-feedback');
      this.readAll = this.dialog.querySelector('[data-dn="read-all"]');
      this.enable = this.dialog.querySelector('[data-dn="enable"]');
      this.panel = this.dialog.querySelector('.dn-panel');
      this.bell.innerHTML = icon('bell');
      this.bell.addEventListener('click', () => this.open());
      this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
      this.dialog.addEventListener('pointerdown', event => { this.onBackdrop = event.target === this.dialog; });
      this.dialog.addEventListener('click', event => this.activate(event));
      const reposition = () => { if (this.dialog.open) this.place(); };
      window.addEventListener('resize', reposition);
      window.visualViewport?.addEventListener('resize', reposition);
      window.visualViewport?.addEventListener('scroll', reposition);
      for (const event of ['online', 'offline']) window.addEventListener(event, () => this.sync());
    }

    icon(name) {
      return Object.hasOwn(iconPaths, name)
        ? `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name]}</svg>`
        : this.options.icon(name);
    }

    get isOpen() { return this.dialog.open; }

    place() {
      const rect = this.bell.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft || 0;
      const viewportTop = viewport?.offsetTop || 0;
      const viewportWidth = viewport?.width || innerWidth;
      const viewportBottom = viewportTop + (viewport?.height || innerHeight);
      const width = Math.min(480, viewportWidth - 24);
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const left = Math.max(viewportLeft + 12, Math.min(x - width / 2, viewportLeft + viewportWidth - width - 12));
      const top = Math.max(viewportTop + 12, rect.bottom + 12);
      const height = Math.min(690, Math.max(0, viewportBottom - top - 12));

      Object.assign(this.dialog.style, {left: `${left}px`, top: `${top}px`, width: `${width}px`});
      this.dialog.style.setProperty('--dn-x', `${x - left}px`);
      this.dialog.style.setProperty('--dn-height', `${height}px`);
      return {x, y};
    }

    animate(closing) {
      const initial = closing && this.motion?.playState === 'running'
        ? {transform: getComputedStyle(this.dialog).transform, opacity: getComputedStyle(this.dialog).opacity}
        : null;
      this.motion?.cancel();
      if (reducedMotion.matches) return;
      const origin = this.place();
      const box = this.dialog.getBoundingClientRect();
      const collapsed = {
        transform: `translate(${origin.x - box.left - box.width / 2}px, ${origin.y - box.top - box.height / 2}px) scale(.12, .09)`,
        opacity: .15
      };
      const open = {transform: 'translate(0, 0) scale(1)', opacity: 1};
      this.motion = this.dialog.animate(closing ? [initial || open, collapsed] : [collapsed, open], {
        duration: closing ? 170 : 360,
        easing: closing ? 'cubic-bezier(.4, 0, .8, .55)' : 'cubic-bezier(.16, 1, .3, 1)',
        fill: closing ? 'forwards' : 'none'
      });
      return this.motion;
    }

    open() {
      if (this.dialog.open || !this.options.owner() || !this.bell.getClientRects().length) return;
      this.filter = 'all';
      this.expanded = '';
      this.message('');
      this.place();
      this.render();
      this.dialog.showModal();
      this.list.scrollTop = 0;
      this.bell.setAttribute('aria-expanded', 'true');
      document.body.classList.add('dn-open');
      this.animate(false);
    }

    close(immediate = false) {
      if (!this.dialog.open) return false;
      const finish = () => {
        this.dialog.close();
        this.motion?.cancel();
        this.dialog.classList.remove('dn-closing');
        this.bell.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('dn-open');
      };
      if (immediate || reducedMotion.matches) finish();
      else if (!this.dialog.classList.contains('dn-closing')) {
        this.dialog.classList.add('dn-closing');
        this.animate(true)?.finished.then(finish, () => {});
      }
      return true;
    }

    reset() {
      ++this.scope;
      this.pending.clear();
      this.enabling = false;
      this.close(true);
      this.list.replaceChildren();
      this.markup = '';
      this.sync();
    }

    unread(record) { return isUnread(record, this.options.owner()); }

    sync() {
      const count = this.options.records().filter(record => this.unread(record)).length;
      const badge = count ? `<i class="nbd" aria-hidden="true">${count > 99 ? '99+' : count}</i>`
        : this.options.pushEnabled() ? '' : '<i class="dot" aria-hidden="true"></i>';
      const current = this.bell.querySelector('.nbd,.dot');
      if ((current?.outerHTML || '') !== badge) {
        current?.remove();
        if (badge) this.bell.insertAdjacentHTML('beforeend', badge);
      }
      this.bell.classList.toggle('has-unread', count > 0);
      this.bell.classList.toggle('on', this.options.pushEnabled());
      if (count) this.bell.setAttribute('aria-description', `عدد الإشعارات غير المقروءة ${number.format(count)}`);
      else this.bell.removeAttribute('aria-description');
      if (this.dialog.open) this.render();
    }

    card(record, date) {
      const {escape} = this.options;
      const id = String(record.id);
      const category = categoryByKind.get(record.kind) || '';
      const expanded = this.expanded === id;
      const unread = this.unread(record);
      const level = ['danger', 'warn', 'success'].includes(record.level) ? record.level : 'info';
      const icon = level === 'danger' || level === 'warn' ? 'alert' :
        level === 'success' && category !== 'payments' ? 'check' : categoryIcons[category] || 'bell';
      const body = String(record.body || '').trim();
      const lines = body.split(/\r?\n/).filter(line => line.trim());
      const fields = new Map(lines.map(lineParts).filter(Boolean).map(([, label, value]) => [label, value]));
      const amount = amountLabels.find(label => fields.has(label));
      const preview = previewLabels.filter(label => fields.has(label)).slice(0, 2).map(label => `${label}: ${fields.get(label)}`).join(' · ');
      const balance = fields.get('المتبقي عليك للإدارة بعد الدفعة');
      const summary = (category === 'notes' && lines.find(line => !lineParts(line))) ||
        (category === 'payments' && balance && `المتبقي عليك للإدارة: ${balance}`) ||
        preview || lines.find(line => !amount || lineParts(line)?.[1] !== amount);
      const detailsId = 'dn-details-' + escape(id);
      return `<article class="dn-card${unread ? ' dn-unread' : ''}" data-level="${level}">
        <div class="dn-card-top">
          <span class="dn-card-icon" aria-hidden="true">${this.icon(icon)}</span>
          <div class="dn-card-heading">
            <h3>${escape(cleanTitle(record.title) || 'إشعار')}</h3>
            <div class="dn-meta">
              <span>${categoryLabels.get(category) || 'أخرى'}</span>
              ${Number.isFinite(date.getTime()) ? `<time datetime="${date.toISOString()}">${escape(timeFormat.format(date))}</time>` : ''}
            </div>
          </div>
          ${unread ? '<span class="dn-unread-dot" role="img" aria-label="غير مقروء"></span>' : ''}
        </div>
        ${summary ? `<p class="dn-preview">${escape(summary)}</p>` : ''}
        ${amount ? `<p class="dn-amount"><span>${amount}</span><strong dir="auto">${escape(fields.get(amount))}</strong></p>` : ''}
        <p id="${detailsId}" class="dn-details" dir="auto"${expanded && body ? '' : ' hidden'}>${escape(body)}</p>
        ${body || unread || record.order_id ? `<div class="dn-card-actions">
          ${body ? `<button type="button" data-dn="details" data-id="${escape(id)}" aria-expanded="${expanded}" aria-controls="${detailsId}">${expanded ? 'إخفاء التفاصيل' : 'التفاصيل'}${this.icon('chevron')}</button>` :
            unread ? `<button type="button" data-dn="read" data-id="${escape(id)}">${this.icon('check')}مقروء</button>` : ''}
          ${record.order_id ? `<button type="button" class="dn-order" data-dn="order" data-id="${escape(id)}">فتح الطلب${this.icon('arrow')}</button>` : ''}
        </div>` : ''}
      </article>`;
    }

    render() {
      const records = this.options.records();
      const total = records.filter(record => this.unread(record)).length;
      const count = this.dialog.querySelector('.dn-count');
      const label = total ? `${number.format(total)} غير مقروء` : 'لا إشعارات غير مقروءة';
      if (count.textContent !== label) count.textContent = label;
      this.readAll.disabled = !total || !this.options.canWrite() || !records.some(record => this.unread(record) && !this.pending.has(record.id));
      this.enable.hidden = this.options.pushEnabled() || !this.options.canEnablePush();
      this.enable.disabled = this.enabling || !this.options.canWrite();
      this.dialog.querySelectorAll('[data-dn="filter"]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.key === this.filter)));

      const visible = records.filter(record => {
        if (this.filter === 'all') return true;
        if (this.filter === 'unread') return this.unread(record) || this.expanded === String(record.id);
        return categoryByKind.get(record.kind) === this.filter;
      });
      const now = new Date();
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString();
      let lastDay = '';
      const markup = visible.map(record => {
        const date = new Date(record.created_at || NaN);
        const [day, label] = dateGroup(date, now.toDateString(), yesterday);
        const heading = day === lastDay ? '' : `<h3 class="dn-day">${label}</h3>`;
        lastDay = day;
        return heading + this.card(record, date);
      }).join('') || `<div class="dn-empty">${this.icon('bell')}<p>${this.filter === 'all' ? 'لا توجد إشعارات بعد' : this.filter === 'unread' ? 'لا توجد إشعارات غير مقروءة' : 'لا توجد إشعارات في هذا التصنيف'}</p></div>`;
      if (markup === this.markup) return;
      const focused = this.list.contains(document.activeElement) ? document.activeElement.dataset : null;
      this.list.innerHTML = this.markup = markup;
      if (focused) {
        const replacement = [...this.list.querySelectorAll('[data-id]')].find(button =>
          button.dataset.id === focused.id && button.dataset.dn === focused.dn);
        (replacement || this.dialog.querySelector('[aria-pressed="true"]')).focus({preventScroll: true});
      }
    }

    message(text, error = false) {
      this.feedback.textContent = text;
      this.feedback.hidden = !text;
      this.feedback.classList.toggle('dn-error', error);
    }

    async mark(records) {
      if (!this.options.canWrite()) return;
      const ids = new Set(records.filter(record => this.unread(record) && !this.pending.has(record.id)).map(record => record.id));
      if (!ids.size) return;
      const owner = this.options.owner();
      const scope = this.scope;
      ids.forEach(id => this.pending.add(id));
      this.message('');
      this.sync();
      try {
        const {error} = await this.options.write([...ids]);
        if (error) throw error;
        if (scope !== this.scope || owner !== this.options.owner()) return;
        for (const record of this.options.records()) {
          if (ids.has(record.id) && this.unread(record)) record.read_by = [...(record.read_by || []), owner];
        }
      } catch (_) {
        if (scope === this.scope && owner === this.options.owner()) this.message('تعذّر تعليم الإشعارات كمقروءة. حاول مجددًا.', true);
      } finally {
        if (scope === this.scope) {
          ids.forEach(id => this.pending.delete(id));
          this.sync();
        }
      }
    }

    async enablePush() {
      if (this.enabling || !this.options.canWrite()) return;
      const scope = this.scope;
      this.enabling = true;
      this.message('');
      this.sync();
      let enabled = false;
      try { enabled = await this.options.enablePush(); } catch (_) {}
      if (scope !== this.scope) return;
      this.enabling = false;
      this.message(enabled ? 'تم تفعيل إشعارات الجهاز.' : 'تعذّر تفعيل الإشعارات. تحقّق من إذن الإشعارات والاتصال.', !enabled);
      this.sync();
    }

    activate(event) {
      if (this.dialog.classList.contains('dn-closing')) return;
      if (this.onBackdrop && event.target === this.dialog) return this.close();
      const button = event.target.closest('[data-dn]');
      if (!button) return;
      const action = button.dataset.dn;
      if (action === 'close') return this.close();
      if (action === 'filter') {
        this.filter = button.dataset.key;
        this.expanded = '';
        this.message('');
        this.render();
        this.list.scrollTop = 0;
        return;
      }
      if (action === 'read-all') {
        this.expanded = '';
        return this.mark(this.options.records());
      }
      if (action === 'enable') return this.enablePush();
      const record = this.options.records().find(record => String(record.id) === button.dataset.id);
      if (!record) return;
      if (action === 'read') return this.mark([record]);
      if (action === 'details') {
        this.expanded = this.expanded === button.dataset.id ? '' : button.dataset.id;
        this.render();
        if (this.expanded) return this.mark([record]);
      }
      if (action === 'order' && record.order_id) {
        void this.mark([record]);
        this.close(true);
        return this.options.openOrder(record.order_id);
      }
    }
  }

  globalThis.DeliveryNotifications = DeliveryNotifications;
})();
