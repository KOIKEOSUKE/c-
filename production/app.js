(function () {
  'use strict';

  const workflow = PrintWorkflow;
  const department = document.body.dataset.department;
  const $ = id => document.getElementById(id);
  const outgoing = Object.entries(workflow.interfaces).filter(([, definition]) => definition.from === department);
  const fields = {
    orderId: ['注文ID'], requestId: ['依頼ID'], proofId: ['校正ID'],
    product: ['品名'], paper: ['用紙'], quantity: ['部数', 'number'],
    dueDate: ['希望納期', 'date'], reason: ['理由'], version: ['版番号', 'number'],
    instruction: ['確認事項'], responseDueDate: ['回答期限', 'date'],
    proofDecision: ['校正回答', ['承認', '修正依頼']], comment: ['修正コメント'],
    decision: ['依頼回答', ['承認', '却下']], confirmedDueDate: ['確定納期', 'date'],
    stage: ['工程', workflow.stages], expectedDate: ['完了見込み日', 'date'],
    completedDate: ['完成日', 'date'], goodQuantity: ['良品部数', 'number'],
    shortageQuantity: ['不足部数', 'number']
  };
  const actionHelp = {
    order: '注文IDと依頼IDは自動で発行します。',
    change: '製造部に承認され、当初分が未完了で、回答待ちのキャンセル依頼がない注文を変更できます。変更後の値を入力してください（部数は追加分を除いた当初分の部数です）。',
    cancel: '製造部に承認され、当初分が未完了で、回答待ちのキャンセル依頼がない注文をキャンセルできます。',
    additional: '承認済みの注文に追加の部数を依頼します。',
    proofReply: '回答待ちの校正がある注文を選び、承認または修正依頼を回答します。修正依頼ではコメントが必須です。'
  };
  const storageKey = 'printWorkflow:' + department;
  let events = [];
  let state = workflow.buildState(events);
  // 台帳CSVに書き出していない変更があるか。リロード後も警告を続けるため一時保存にも含める。
  let unsaved = false;
  let storageOk = true;

  function element(tag, content) {
    const item = document.createElement(tag);
    if (content !== undefined) item.textContent = content;
    return item;
  }

  function option(value, label) {
    const item = element('option', label);
    item.value = value;
    return item;
  }

  function select(name, options) {
    const input = element('select');
    input.name = name;
    const placeholder = option('', options.length ? '選択してください' : '対象データがありません');
    placeholder.disabled = true;
    placeholder.selected = true;
    input.append(placeholder, ...options.map(([value, label]) => option(value, label)));
    return input;
  }

  function show(message, error = false) {
    $('message').textContent = message;
    $('message').dataset.error = String(error);
  }

  function localDate() {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function identifier(prefix) {
    return prefix + '-' + Array.from(crypto.getRandomValues(new Uint32Array(3)), number =>
      number.toString(36).padStart(7, '0')).join('');
  }

  function orderChoices(type) {
    const orders = [...state.orders.values()];
    if (type === 'reply') {
      return orders.filter(order => [...state.requests.values()].some(request =>
        request.orderId === order.id && !request.answer));
    }
    if (type === 'proofReply') {
      return orders.filter(order => workflow.availableOrder(order) &&
        [...state.proofs.values()].some(proof => proof.orderId === order.id && !proof.answer));
    }
    if (['change', 'cancel'].includes(type)) {
      // 未回答のキャンセル依頼がある注文は、承認されると後続の依頼を承認できなくなるため除外する。
      return orders.filter(order => workflow.availableOrder(order) && !order.initialFinished &&
        ![...state.requests.values()].some(request =>
          request.orderId === order.id && request.type === 'cancel' && !request.answer));
    }
    return orders.filter(workflow.availableOrder);
  }

  function requestChoices(type, order) {
    return [...state.requests.values()]
      .filter(request => order && request.orderId === order.id)
      .filter(request => type === 'reply' ? !request.answer :
        ['order', 'additional'].includes(request.type) && request.answer === '承認' && !request.finished)
      .map(request => [request.requestId, workflow.interfaces[request.type].name + ' · ' +
        (type === 'finish' ? request.targetQuantity + '部 · ' : '') + request.requestId]);
  }

  function proofChoices(order) {
    return [...state.proofs.values()].filter(proof => order && proof.orderId === order.id && !proof.answer)
      .map(proof => [proof.proofId, '第' + proof.version + '版 · ' + proof.instruction]);
  }

  function automaticField(type, field) {
    return field === 'updatedAt' || (type === 'order' && field === 'orderId') ||
      (['order', 'change', 'cancel', 'additional'].includes(type) && field === 'requestId') ||
      (type === 'proof' && field === 'proofId');
  }

  function inputFor(type, field, order) {
    const [, kind] = fields[field];
    if (field === 'orderId') {
      return select(field, orderChoices(type).map(item => [item.id, item.product + ' · ' + item.id]));
    }
    if (field === 'requestId') return select(field, requestChoices(type, order));
    if (field === 'proofId') return select(field, proofChoices(order));
    if (Array.isArray(kind)) return select(field, kind.map(value => [value, value]));

    const input = element(field === 'comment' || field === 'instruction' ? 'textarea' : 'input');
    input.name = field;
    if (input.tagName === 'INPUT') input.type = kind || 'text';
    if (input.type === 'number') {
      input.min = ['goodQuantity', 'shortageQuantity'].includes(field) ? '0' : '1';
      input.step = '1';
    }
    if (field === 'completedDate') input.value = localDate();
    if (field === 'version') {
      const last = [...state.proofs.values()].filter(proof => order && proof.orderId === order.id).at(-1);
      input.value = last ? Number(last.version) + 1 : 1;
    }
    if (type === 'change' && order && ['paper', 'quantity', 'dueDate'].includes(field)) {
      // 変更できるのは当初分なので、部数は追加分を含まない当初分の部数を初期値にする。
      input.value = field === 'quantity' ? order.initialQuantity : order[field];
    }
    return input;
  }

  function renderForm(selectedOrder = '') {
    const type = $('operation').value;
    const definition = workflow.interfaces[type];
    const order = state.orders.get(selectedOrder);
    const formFields = $('fields');
    formFields.replaceChildren();

    for (const field of definition.fields) {
      if (automaticField(type, field)) continue;
      const label = element('label');
      const input = inputFor(type, field, order);
      input.required = !['comment', 'confirmedDueDate'].includes(field) &&
        !(field === 'reason' && type === 'reply');
      if (field === 'orderId' && selectedOrder) input.value = selectedOrder;
      if (field === 'orderId') input.addEventListener('change', () => {
        renderForm(input.value);
        formFields.querySelector('[name="orderId"]').focus();
      });
      label.append(element('span', fields[field][0] + (input.required ? ' *' : '')), input);
      formFields.append(label);
    }
    $('action-help').textContent = actionHelp[type] ||
      '対象の注文を選択してください。関連する依頼や校正は注文を選ぶと表示されます。';
    $('save-event').disabled = type !== 'order' && orderChoices(type).length === 0;
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const link = element('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function eventDownload(event) {
    download(event.type + '-' + event.orderId + '-' + event.eventId + '.csv',
      workflow.exportExchange(event.type, [event]));
  }

  function statusOf(order) {
    const request = state.requests.get(order.originalRequestId);
    if (order.cancelled) return 'キャンセル済み';
    if (!order.approved) return request.answer === '却下' ? '製造依頼却下' : '製造承認待ち';
    if (order.finished) return order.goodQuantity < order.quantity ? '完了・不足あり' : '完了';
    if (order.initialFinished) return '当初分完了・追加製造中';
    return order.progress || '製造承認済み';
  }

  function rowMessage(tableBody, columns, message) {
    const row = element('tr');
    const cell = element('td', message);
    cell.colSpan = columns;
    cell.className = 'empty';
    row.append(cell);
    tableBody.append(row);
  }

  function renderOrders() {
    const list = $('orders');
    list.replaceChildren();
    for (const order of [...state.orders.values()].reverse()) {
      const row = element('tr');
      const values = [order.id, order.product, order.paper, order.quantity + '部', order.dueDate,
        statusOf(order), order.proofStatus || '—', order.expectedDate || '—',
        order.delayReason || '—', order.initialFinished || order.goodQuantity ? order.goodQuantity + '部' : '—'];
      row.append(...values.map(value => element('td', value)));
      list.append(row);
    }
    if (!list.children.length) rowMessage(list, 10, '注文がありません。');
    $('order-count').textContent = state.orders.size + '件';
  }

  function renderHistory() {
    const list = $('history');
    list.replaceChildren();
    for (const event of [...events].reverse()) {
      const definition = workflow.interfaces[event.type];
      const sent = definition.from === department;
      const row = element('tr');
      const detail = element('details');
      detail.append(element('summary', '内容を見る'));
      const metadata = element('dl');
      for (const field of definition.fields) {
        metadata.append(element('dt', fields[field]?.[0] || '更新日時'), element('dd', event[field] || '—'));
      }
      detail.append(metadata);
      const detailCell = element('td');
      detailCell.append(detail);
      const actionCell = element('td');
      if (sent) {
        const button = element('button', 'CSVを書き出す');
        button.type = 'button';
        button.className = 'secondary';
        button.addEventListener('click', () => eventDownload(event));
        actionCell.append(button);
      } else {
        actionCell.textContent = '—';
      }
      row.append(element('td', sent ? '送信側' : '受信側'), element('td', definition.name),
        element('td', event.orderId), detailCell, actionCell);
      list.append(row);
    }
    if (!list.children.length) rowMessage(list, 5, 'やり取りはまだありません。');
  }

  function renderAutosave() {
    $('autosave').textContent = !storageOk ?
      'ブラウザ内への一時保存ができません。閉じる前に必ず台帳をCSVで保存してください。' :
      unsaved ? '台帳CSVに未保存の変更があります（ブラウザ内には自動で一時保存済みです）。' :
      '台帳CSVの保存は最新です。';
    $('autosave').dataset.error = String(!storageOk || unsaved);
  }

  function refresh() {
    state = workflow.buildState(events);
    renderOrders();
    renderHistory();
    renderForm();
    renderAutosave();
  }

  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ events, unsaved, savedAt: new Date().toISOString() }));
      storageOk = true;
    } catch {
      storageOk = false;
    }
  }

  // 台帳を差し替えたら、一時保存と画面を更新する。
  function setEvents(next, changed) {
    events = next;
    unsaved = changed;
    persist();
    refresh();
  }

  function restore() {
    let raw;
    try {
      raw = localStorage.getItem(storageKey);
    } catch {
      storageOk = false;
      return;
    }
    if (!raw) return;
    try {
      const saved = JSON.parse(raw);
      if (!saved || !Array.isArray(saved.events)) throw new Error('形式が不正です。');
      workflow.buildState(saved.events);
      events = saved.events;
      unsaved = Boolean(saved.unsaved);
      if (!events.length) return;
      const time = saved.savedAt ? new Date(saved.savedAt).toLocaleString('ja-JP') : '不明';
      show('前回の作業を自動で復元しました（' + events.length + '件、' + time + ' 時点）。' +
        (unsaved ? '台帳CSVへの保存がまだのため、区切りのよいところで保存してください。' : ''));
    } catch (error) {
      // 壊れたデータは上書きせず退避しておく。
      try {
        localStorage.setItem(storageKey + ':broken', raw);
        localStorage.removeItem(storageKey);
      } catch { /* 退避できなくても画面は空の台帳で続行する */ }
      show('一時保存データを復元できませんでした。保存済みの台帳CSVを開き直してください。' + error.message, true);
    }
  }

  $('operation').append(...outgoing.map(([type, definition]) => option(type, definition.name)));
  $('operation').addEventListener('change', () => renderForm());

  $('entry').addEventListener('submit', event => {
    event.preventDefault();
    const type = $('operation').value;
    const data = Object.fromEntries(new FormData($('entry')));
    const item = { eventId: identifier('EV'), type, ...data };
    if (type === 'order') item.orderId = identifier('ORD');
    if (['order', 'change', 'cancel', 'additional'].includes(type)) item.requestId = identifier('REQ');
    if (type === 'proof') item.proofId = identifier('PRF');
    if (type === 'progress') item.updatedAt = new Date().toISOString();

    try {
      setEvents(workflow.mergeEvents(events, [item]).events, true);
      eventDownload(item);
      show(workflow.interfaces[type].name + 'を登録し、CSVを書き出しました。');
    } catch (error) {
      show(error.message, true);
    }
  });

  $('incoming').addEventListener('change', async event => {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    input.disabled = true;
    try {
      const text = await file.text();
      const result = workflow.mergeEvents(events, workflow.readExchange(text, department));
      setEvents(result.events, unsaved || result.accepted > 0);
      show(file.name + ' を取り込みました。新規 ' + result.accepted + ' 件、取り込み済み ' + result.skipped + ' 件。');
    } catch (error) {
      show('取り込みを中止しました。' + error.message, true);
    } finally {
      input.disabled = false;
      input.value = '';
    }
  });

  $('save-backup').addEventListener('click', () => {
    download(department + '-backup-' + localDate() + '.csv', workflow.exportBackup(department, events));
    setEvents(events, false);
    show('台帳を保存しました。再開時は「台帳を開く」を使ってください。');
  });

  $('backup').addEventListener('change', async event => {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    try {
      const saved = workflow.readBackup(department, await file.text());
      if (events.length && !confirm(unsaved ?
        '現在の台帳には台帳CSVに未保存の変更があります。置き換えると失われます。置き換えますか？' :
        '現在の台帳を置き換えますか？')) return;
      setEvents(saved, false);
      show('保存済みの台帳を開きました。');
    } catch (error) {
      show('台帳を開けませんでした。' + error.message, true);
    } finally {
      input.value = '';
    }
  });

  const guidance = $('csv-types');
  for (const [type, definition] of Object.entries(workflow.interfaces)) {
    const item = element('li', (definition.from === department ? '書き出し' : '取り込み') + ' · ' +
      definition.name + '（' + type + '）');
    guidance.append(item);
  }

  $('clear-ledger').addEventListener('click', () => {
    if (!events.length) return;
    if (!confirm((unsaved ? '台帳CSVに未保存の変更があります。' : '') +
      '画面とブラウザ内の台帳を消去します。よろしいですか？')) return;
    setEvents([], false);
    show('台帳を消去しました。');
  });

  // 台帳CSVに保存していない変更があれば、リロード・タブを閉じる前に確認する。
  window.addEventListener('beforeunload', event => {
    if (!unsaved) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // 同じ部署の画面を別タブで操作すると、一時保存を互いに上書きしてしまう。
  window.addEventListener('storage', event => {
    if (event.key !== storageKey) return;
    show('同じ部署の画面が別のタブで更新されました。上書きを防ぐため、このタブを閉じて一方の画面だけで作業してください。', true);
  });

  restore();
  refresh();
})();