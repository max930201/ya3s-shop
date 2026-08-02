// ===== Firebase 設定 =====
    const firebaseConfig = {
      // ⚠️ 資安風險提示：前端金鑰洩漏風險（見後文說明）
      apiKey: "AIzaSyAv_F_g8_4fwu9zOs-tnjD_jP2MmlZmYIQ",
      authDomain: "yasss-bag.firebaseapp.com",
      projectId: "yasss-bag",
      storageBucket: "yasss-bag.firebasestorage.app",
      messagingSenderId: "772211677945",
      appId: "1:772211677945:web:7eebe949dae15dd097a028",
      measurementId: "G-P787KG0ML1"
    };

    firebase.initializeApp(firebaseConfig);

    // ===== App Check 初始化 =====
    // 本地測試（localhost）才會啟用 Debug Token，正式網域不會受影響
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }
    const appCheck = firebase.appCheck();
    appCheck.activate(
      '6Lfpq18tAAAAALhZP7cIlyXRGlCEZBTat5UruVcE', // Google reCAPTCHA 網站金鑰（site key，公開安全）
      true // 自動更新 token
    );

    const db = firebase.firestore();
    const auth = firebase.auth();

    // ===== Cloudinary 設定 =====
    const CLOUDINARY_CLOUD_NAME = 'dv8ani3pd';
    const CLOUDINARY_UPLOAD_PRESET = 'ya3s_upload';
    const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
    const CLOUDINARY_SIGN_ENDPOINT = '/.netlify/functions/cloudinary-sign';

    const ORDER_STATUS_LABELS = {
      pending: '處理中',
      confirmed: '已確認',
      unpaid: '未付款',
      preparing: '待出貨',
      shipping: '寄送中',
      arrived: '已送達指定地點',
      completed: '已完成',
      cancelled: '已取消'
    };

    // 與商品新增／編輯表單的品牌下拉選單保持一致，品牌管理頁面共用同一份清單
    const KNOWN_BRANDS = ['Chanel', 'Louis Vuitton', 'Hermes', 'Gucci', 'Prada', 'Burberry'];

    // 與商品新增／編輯表單的「商品類別」下拉選單保持一致，用來判斷選單裡是否已有這個類別
    // （若不在清單內，代表是透過「其他」自訂輸入的類別，前台篩選會直接顯示該自訂文字）
    const KNOWN_BAG_TYPES = [
      '托特包', '肩背包', '斜背包', '手拿包', '水桶包', '後背包', '旅行袋', '化妝包',
      '耳環', '項鍊', '手鍊/手環', '戒指', '絲巾', '皮帶', '太陽眼鏡', '鑰匙圈'
    ];

    const $ = selector => document.querySelector(selector);
    const $$ = selector => Array.from(document.querySelectorAll(selector));

    // 防止 XSS：任何來自使用者輸入（會員顯示名稱、LINE ID、電話、訂單聯絡方式等）
    // 且會被塞進 innerHTML 的文字，一律要先經過這裡轉義。
    function escapeHtml(text) {
      return String(text ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[char]));
    }

    let selectedFiles = [];
    let allProducts = [];
    let allOrders = [];
    let allMembers = [];
    let selectedMemberForOrder = null;
    let orderStatusFilter = 'all';
    let currentOrderIdForTransaction = null;
    let currentProductIdForEdit = null;
    let currentEditImages = []; // 編輯視窗中目前的圖片 URL 陣列（排序、刪除、新增都先在這裡操作，儲存時才一次寫回 Firestore）
    let orderListExpanded = false;
    // 🛠 新增：控制已完成訂單展開狀態的變數
    let historyListExpanded = false;
    // 品牌管理（WE CARRY）：doc id = 品牌名稱，資料為 { logoUrl, enabled }
    let brandShowcaseMap = {};

    function init() {
      bindLoginEvents();
      bindFormEvents();
      bindOrderEvents();
      bindTransactionModal();
      bindEditProductModal();
      bindBrandManagement();
      listenToAuthState();
    }

    function bindBrandManagement() {
      $('#brandAddForm').addEventListener('submit', event => {
        event.preventDefault();
        const input = $('#newBrandInput');
        addCustomBrand(input.value);
        input.value = '';
      });
    }

    // ===== 交易資訊彈窗邏輯 =====
    function bindTransactionModal() {
      $('#transactionCancelButton').addEventListener('click', closeTransactionModal);
      $('#transactionForm').addEventListener('submit', handleTransactionSubmit);

      const today = new Date().toISOString().split('T')[0];
      $('#transactionDeliveryDate').value = today;
    }

    function openTransactionModal(orderId, order) {
      currentOrderIdForTransaction = orderId;
      $('#transactionBuyerName').value = order.customerName || '';
      
      if (order.transactionData) {
        const d = order.transactionData;
        $('#transactionDeliveryDate').value = d.deliveryDate || '';
        $('#transactionDeliveryLocation').value = d.deliveryLocation || '';
        $('#transactionBankAccount').value = d.bankAccount || '';
        $('#transactionNotes').value = d.notes || '';
      } else {
        $('#transactionDeliveryLocation').value = '';
        $('#transactionBankAccount').value = '';
        $('#transactionNotes').value = '';
      }

      $('#transactionModal').classList.add('show');
    }

    function closeTransactionModal() {
      $('#transactionModal').classList.remove('show');
      currentOrderIdForTransaction = null;
    }

    async function handleTransactionSubmit(event) {
      event.preventDefault();
      if (!currentOrderIdForTransaction) return;

      const buyerName = $('#transactionBuyerName').value.trim();
      const deliveryDate = $('#transactionDeliveryDate').value;
      const deliveryLocation = $('#transactionDeliveryLocation').value.trim();
      const bankAccount = $('#transactionBankAccount').value.trim();
      const notes = $('#transactionNotes').value.trim();

      try {
        await db.collection('orders').doc(currentOrderIdForTransaction).update({
          transactionData: {
            buyerName,
            deliveryDate,
            deliveryLocation,
            bankAccount,
            notes,
            recordedAt: firebase.firestore.FieldValue.serverTimestamp()
          }
        });
        showToast('交易資訊已保存');
        closeTransactionModal();
      } catch (error) {
        console.error(error);
        showToast('保存失敗，請再試一次');
      }
    }

    // ===== 登入邏輯 =====
    function bindLoginEvents() {
      $('#loginForm').addEventListener('submit', async event => {
        event.preventDefault();
        const email = $('#emailInput').value.trim();
        const password = $('#passwordInput').value;
        const submitButton = $('#loginSubmitButton');

        $('#loginError').hidden = true;
        submitButton.disabled = true;

        try {
          await auth.signInWithEmailAndPassword(email, password);
        } catch (error) {
          $('#loginError').textContent = translateAuthError(error);
          $('#loginError').hidden = false;
        } finally {
          submitButton.disabled = false;
        }
      });

      $('#logoutButton').addEventListener('click', () => auth.signOut());
      $('#forbiddenLogoutButton').addEventListener('click', () => auth.signOut());
    }

    function translateAuthError(error) {
      const map = {
        'auth/invalid-email': 'Email 格式不正確',
        'auth/user-not-found': '帳號不存在',
        'auth/wrong-password': '密碼錯誤',
        'auth/invalid-credential': 'Email 或密碼錯誤',
        'auth/too-many-requests': '嘗試次數過多，請稍後再試'
      };
      return map[error.code] || '登入失敗，請再試一次';
    }

    function listenToAuthState() {
      auth.onAuthStateChanged(async user => {
        if (!user) {
          showLogin();
          return;
        }

        try {
          const idTokenResult = await user.getIdTokenResult(true);
          
          console.log("當前登入 UID:", user.uid);
          console.log("擁擁有 Claims 標籤:", idTokenResult.claims);

          if (idTokenResult.claims && idTokenResult.claims.admin === true) {
            showAdmin();
          } else {
            console.warn("⚠️ 登入成功，但此帳號的 Token 內沒有 admin: true 標籤！");
            showForbidden();
          }
        } catch (error) {
          console.error('驗證管理員權限失敗：', error);
          showForbidden();
        }
      });
    }

    function showLogin() {
      $('#loginScreen').hidden = false;
      $('#forbiddenScreen').hidden = true;
      $('#adminScreen').hidden = true;
      $('#passwordInput').value = '';
    }

    function showForbidden() {
      $('#loginScreen').hidden = true;
      $('#forbiddenScreen').hidden = false;
      $('#adminScreen').hidden = true;
    }

    function showAdmin() {
      $('#loginScreen').hidden = true;
      $('#forbiddenScreen').hidden = true;
      $('#adminScreen').hidden = false;
      listenToProducts();
      listenToOrders();
      listenToMembers();
      loadAllMembers();
      listenToBrandShowcase();
    }

    // ===== 表單與圖片預覽 =====
    function bindFormEvents() {
      $('#imageInput').addEventListener('change', event => {
        selectedFiles = Array.from(event.target.files || []);
        renderPreview();
      });

      $('#brandInput').addEventListener('change', event => {
        const isOther = event.target.value === '其他';
        $('#otherBrandLabel').hidden = !isOther;
        if (isOther) {
          $('#otherBrandInput').required = true;
          $('#otherBrandInput').focus();
        } else {
          $('#otherBrandInput').required = false;
          $('#otherBrandInput').value = '';
        }
      });

      $('#bagTypeInput').addEventListener('change', event => {
        const isOther = event.target.value === '其他';
        $('#otherBagTypeLabel').hidden = !isOther;
        if (isOther) {
          $('#otherBagTypeInput').required = true;
          $('#otherBagTypeInput').focus();
        } else {
          $('#otherBagTypeInput').required = false;
          $('#otherBagTypeInput').value = '';
        }
      });

      $('#productForm').addEventListener('submit', handleSubmit);
    }

    function renderPreview() {
      const row = $('#previewRow');
      if (!selectedFiles.length) {
        row.innerHTML = '';
        return;
      }
      row.innerHTML = selectedFiles.map((file, index) => {
        const url = URL.createObjectURL(file);
        return `<span class="preview-item${index === 0 ? ' cover' : ''}"><img src="${url}" alt="預覽圖 ${index + 1}">${index === 0 ? '<small>封面</small>' : ''}</span>`;
      }).join('');
    }

    async function getCloudinarySignature() {
      const response = await fetch(CLOUDINARY_SIGN_ENDPOINT, { method: 'POST' });
      if (!response.ok) {
        throw new Error('無法取得上傳簽章，請確認後台 Functions 已正確部署');
      }
      return response.json();
    }

    async function uploadImagesToCloudinary(files) {
      const urls = [];
      for (let i = 0; i < files.length; i++) {
        setUploadStatus(`圖片上傳中（${i + 1}/${files.length}）...`);

        const { signature, timestamp, apiKey } = await getCloudinarySignature();

        const formData = new FormData();
        formData.append('file', files[i]);
        formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
        formData.append('api_key', apiKey);
        formData.append('timestamp', timestamp);
        formData.append('signature', signature);

        const response = await fetch(CLOUDINARY_UPLOAD_URL, {
          method: 'POST',
          body: formData
        });

        if (!response.ok) {
          throw new Error('圖片上傳失敗，請檢查網路後再試一次');
        }

        const data = await response.json();
        urls.push(data.secure_url);
      }
      return urls;
    }

    function setUploadStatus(message) {
      const el = $('#uploadStatus');
      el.hidden = false;
      el.textContent = message;
    }

    async function handleSubmit(event) {
      event.preventDefault();

      if (!selectedFiles.length) {
        showToast('請至少選擇一張商品照片');
        return;
      }

      const productNo = $('#productNoInput').value.trim();
      const isDuplicate = allProducts.some(item => (item.productNo || '').toLowerCase() === productNo.toLowerCase());
      if (isDuplicate) {
        showToast('此商品編號已被使用，請換一個');
        return;
      }

      const submitButton = $('#submitButton');
      submitButton.disabled = true;

      try {
        setUploadStatus('準備上傳圖片...');
        const imageUrls = await uploadImagesToCloudinary(selectedFiles);

        setUploadStatus('圖片上傳完成，正在建立商品...');
        
        let finalBrand = $('#brandInput').value;
        if (finalBrand === '其他') {
          finalBrand = $('#otherBrandInput').value.trim() || '其他';
        }

        let finalBagType = $('#bagTypeInput').value;
        if (finalBagType === '其他') {
          finalBagType = $('#otherBagTypeInput').value.trim() || '未分類';
        } else if (!finalBagType) {
          finalBagType = '未分類';
        }

        await db.collection('products').add({
          productNo,
          brand: finalBrand,
          bagType: finalBagType,
          name: $('#nameInput').value.trim(),
          subtitle: $('#subtitleInput').value.trim(),
          condition: $('#conditionInput').value.trim(),
          price: Number($('#priceInput').value),
          images: imageUrls,
          status: 'active',
          showInHero: $('#heroInput').checked,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        showToast('商品上架成功！');
        resetForm();
      } catch (error) {
        console.error(error);
        showToast(error.message || '上架失敗，請再試一次');
      } finally {
        submitButton.disabled = false;
        $('#uploadStatus').hidden = true;
      }
    }

    function resetForm() {
      $('#productForm').reset();
      $('#otherBrandLabel').hidden = true;
      $('#otherBrandInput').required = false;
      $('#otherBagTypeLabel').hidden = true;
      $('#otherBagTypeInput').required = false;
      selectedFiles = [];
      renderPreview();
    }

    function getProductImage(product) {
      if (Array.isArray(product.images) && product.images.length && product.images[0]) {
        return product.images[0];
      }
      if (product.imgSrc) {
        return product.imgSrc;
      }
      return '';
    }

    function getProductNo(product) {
      return product.productNo || product.id;
    }

    function getOrderCustomerName(order) {
      if (order.userId) {
        const member = allMembers.find(item => item.uid === order.userId);
        if (member && member.displayName) {
          return member.displayName;
        }
      }
      return order.customerName || order.userEmail || '未提供';
    }

    function listenToProducts() {
      db.collection('products')
        .orderBy('createdAt', 'desc')
        .onSnapshot(snapshot => {
          allProducts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          renderProductList(allProducts);
          renderOrderProductOptions(allProducts);
        }, error => {
          console.error('讀取商品清單失敗：', error);
        });
    }

    // ========== 會員管理 ==========
    function listenToMembers() {
      db.collection('users')
        .onSnapshot(snapshot => {
          const members = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          renderMemberList(members);
        }, error => {
          console.error('讀取會員清單失敗：', error);
        });
    }

    function renderMemberList(members) {
      $('#memberCount').textContent = members.length;
      const list = $('#memberList');

      if (!members.length) {
        list.innerHTML = '<p class="empty">目前還沒有會員資料。</p>';
        return;
      }

      list.innerHTML = members.map(member => `
        <article class="admin-member-card" data-member-id="${escapeHtml(member.id)}">
          <div class="admin-member-info">
            <strong>${escapeHtml(member.displayName) || '（未設定姓名）'}</strong>
            <small>${escapeHtml(member.email)}</small>
            <div class="admin-member-contact-display" data-role="display">
              <span>Line ID：<strong data-field="lineId">${escapeHtml(member.lineId) || '未設定'}</strong></span>
              <span>電話：<strong data-field="phone">${escapeHtml(member.phone) || '未設定'}</strong></span>
            </div>
            <div class="admin-member-contact-edit" data-role="edit" hidden>
              <input type="text" data-input="lineId" placeholder="Line ID" value="${escapeHtml(member.lineId)}" />
              <input type="tel" data-input="phone" placeholder="聯絡電話" value="${escapeHtml(member.phone)}" />
            </div>
          </div>
          <div class="admin-member-actions">
            <button type="button" data-action="edit-contact">編輯聯絡資訊</button>
            <button type="button" class="primary-button" data-action="save-contact" hidden>儲存</button>
            <button type="button" data-action="cancel-contact" hidden>取消</button>
          </div>
        </article>
      `).join('');

      list.querySelectorAll('[data-action="edit-contact"]').forEach(button => {
        button.addEventListener('click', () => toggleMemberContactEdit(button.closest('.admin-member-card'), true));
      });
      list.querySelectorAll('[data-action="cancel-contact"]').forEach(button => {
        button.addEventListener('click', () => toggleMemberContactEdit(button.closest('.admin-member-card'), false));
      });
      list.querySelectorAll('[data-action="save-contact"]').forEach(button => {
        button.addEventListener('click', () => saveMemberContact(button.closest('.admin-member-card')));
      });
    }

    function toggleMemberContactEdit(card, isEditing) {
      card.querySelector('[data-role="display"]').hidden = isEditing;
      card.querySelector('[data-role="edit"]').hidden = !isEditing;
      card.querySelector('[data-action="edit-contact"]').hidden = isEditing;
      card.querySelector('[data-action="save-contact"]').hidden = !isEditing;
      card.querySelector('[data-action="cancel-contact"]').hidden = !isEditing;
    }

    async function saveMemberContact(card) {
      const memberId = card.dataset.memberId;
      const lineId = card.querySelector('[data-input="lineId"]').value.trim();
      const phone = card.querySelector('[data-input="phone"]').value.trim();
      const saveButton = card.querySelector('[data-action="save-contact"]');
      saveButton.disabled = true;

      try {
        await db.collection('users').doc(memberId).update({
          lineId: lineId,
          phone: phone,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        card.querySelector('[data-field="lineId"]').textContent = lineId || '未設定';
        card.querySelector('[data-field="phone"]').textContent = phone || '未設定';
        toggleMemberContactEdit(card, false);
      } catch (error) {
        console.error('更新會員聯絡資訊失敗：', error);
        alert('更新失敗，請再試一次');
      } finally {
        saveButton.disabled = false;
      }
    }

    function renderProductList(products) {
      $('#productCount').textContent = products.length;
      const list = $('#productList');

      if (!products.length) {
        list.innerHTML = '<p class="empty">目前還沒有商品，上架第一件商品看看吧！</p>';
        return;
      }

      list.innerHTML = products.map(product => {
        const imageUrl = getProductImage(product);
        const isHero = !!product.showInHero;
        return `
        <article class="admin-product-card ${product.status === 'sold' ? 'is-sold' : ''}">
          ${imageUrl
            ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(product.name)}">`
            : `<span class="no-image">無圖片</span>`}
          <div class="admin-product-info">
            <small>NO. ${escapeHtml(getProductNo(product))} · ${escapeHtml(product.brand)} · ${escapeHtml(product.bagType) || '未分類'}</small>
            <strong>${escapeHtml(product.name)}</strong>
            <span>NT$ ${Number(product.price || 0).toLocaleString('zh-TW')}</span>
            <em>${product.status === 'sold' ? '已下架／售出' : '上架中'}</em>
          </div>
            <div class="admin-product-actions">
              <button type="button" class="${isHero ? 'hero-active' : ''}" data-action="hero" data-id="${escapeHtml(product.id)}" data-hero="${isHero}" title="${isHero ? '點擊移出輪播' : '加入首頁輪播'}">
                ${isHero ? '★ 輪播中' : '☆ 加入輪播'}
              </button>
              <button type="button" data-action="edit" data-id="${escapeHtml(product.id)}">
                編輯資訊
              </button>
              <button type="button" data-action="toggle" data-id="${escapeHtml(product.id)}" data-status="${product.status}">
                ${product.status === 'sold' ? '重新上架' : '標記售出'}
              </button>
              <button type="button" class="danger" data-action="delete" data-id="${escapeHtml(product.id)}">刪除</button>
            </div>
        </article>
      `;
      }).join('');

        list.querySelectorAll('[data-action="hero"]').forEach(button => {
          button.addEventListener('click', () => toggleHero(button.dataset.id, button.dataset.hero === 'true'));
        });
        list.querySelectorAll('[data-action="edit"]').forEach(button => {
          button.addEventListener('click', () => openEditModal(button.dataset.id));
        });
        list.querySelectorAll('[data-action="toggle"]').forEach(button => {
          button.addEventListener('click', () => toggleStatus(button.dataset.id, button.dataset.status));
        });
        list.querySelectorAll('[data-action="delete"]').forEach(button => {
          button.addEventListener('click', () => deleteProduct(button.dataset.id));
        });
    }

    async function toggleHero(id, currentlyInHero) {
      try {
        await db.collection('products').doc(id).update({ showInHero: !currentlyInHero });
        showToast(!currentlyInHero ? '已加入首頁輪播' : '已從輪播移除');
      } catch (error) {
        console.error(error);
        showToast('操作失敗，請再試一次');
      }
    }

    async function toggleStatus(id, currentStatus) {
      const nextStatus = currentStatus === 'sold' ? 'active' : 'sold';
      try {
        await db.collection('products').doc(id).update({ status: nextStatus });
        showToast(nextStatus === 'sold' ? '已標記為售出' : '已重新上架');
      } catch (error) {
        console.error(error);
        showToast('操作失敗，請再試一次');
      }
    }

    async function deleteProduct(id) {
      if (!confirm('確定要刪除這件商品嗎？此動作無法復原。')) return;
      try {
        await db.collection('products').doc(id).delete();
        showToast('商品已刪除');
      } catch (error) {
        console.error(error);
        showToast('刪除失敗，請再試一次');
      }
    }

    // ===== 品牌管理（WE CARRY）邏輯 =====
    // 與商品完全脫鉤：doc id 為 Firestore 自動產生，品牌名稱存在欄位 brand 裡
    // （跟其他 collection 一致的規則風格：一律用欄位內容判斷，不依賴文檔ID格式）
    function listenToBrandShowcase() {
      db.collection('brandShowcase').onSnapshot(snapshot => {
        brandShowcaseMap = {};
        snapshot.docs.forEach(doc => {
          brandShowcaseMap[doc.id] = doc.data();
        });
        renderBrandManageList();
      }, error => {
        console.error('讀取品牌管理清單失敗：', error);
      });
    }

    // 依品牌名稱找出對應的 Firestore 文檔，回傳 [docId, data]；找不到回傳 null
    function findBrandEntry(brandName) {
      const entry = Object.entries(brandShowcaseMap).find(([, data]) => data.brand === brandName);
      return entry || null;
    }

    function renderBrandManageList() {
      const customBrands = [...new Set(Object.values(brandShowcaseMap).map(data => data.brand))]
        .filter(brand => brand && !KNOWN_BRANDS.includes(brand))
        .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
      const allBrands = [...KNOWN_BRANDS, ...customBrands];

      const list = $('#brandManageList');
      list.innerHTML = allBrands.map(brand => {
        const entry = findBrandEntry(brand);
        const data = entry ? entry[1] : {};
        const isEnabled = !!data.enabled;
        const logoUrl = data.logoUrl || '';
        const letter = brand.charAt(0).toUpperCase();
        const safeBrand = brand.replace(/'/g, "\\'");
        const isCustom = !KNOWN_BRANDS.includes(brand);
        return `
        <article class="brand-manage-card">
          ${logoUrl
            ? `<img class="brand-manage-logo" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(brand)}">`
            : `<span class="brand-letter-avatar">${escapeHtml(letter)}</span>`}
          <div class="brand-manage-info">
            <strong>${escapeHtml(brand)}</strong>
            <span>${logoUrl ? 'Logo 已設定' : '尚未上傳 Logo，暫用字母顯示'}</span>
          </div>
          <div class="brand-manage-actions">
            <button type="button" class="${isEnabled ? 'enabled-active' : ''}" data-action="toggle-brand" data-brand="${escapeHtml(brand)}" data-enabled="${isEnabled}">
              ${isEnabled ? '★ WE CARRY 露出中' : '☆ 加入 WE CARRY'}
            </button>
            <button type="button" data-action="upload-brand-logo" data-brand="${escapeHtml(brand)}">
              ${logoUrl ? '更換 Logo' : '上傳 Logo'}
            </button>
            ${isCustom ? `<button type="button" class="danger" data-action="remove-brand" data-brand="${escapeHtml(brand)}">移除品牌</button>` : ''}
            <input type="file" accept="image/*" class="brand-logo-file-input" data-brand-input="${escapeHtml(safeBrand)}" hidden />
          </div>
        </article>
      `;
      }).join('');

      list.querySelectorAll('[data-action="toggle-brand"]').forEach(button => {
        button.addEventListener('click', () => toggleBrandEnabled(button.dataset.brand, button.dataset.enabled === 'true'));
      });
      list.querySelectorAll('[data-action="upload-brand-logo"]').forEach(button => {
        button.addEventListener('click', () => {
          const brand = button.dataset.brand;
          const fileInput = list.querySelector(`.brand-logo-file-input[data-brand-input="${brand.replace(/'/g, "\\'")}"]`);
          fileInput.click();
        });
      });
      list.querySelectorAll('[data-action="remove-brand"]').forEach(button => {
        button.addEventListener('click', () => removeBrand(button.dataset.brand));
      });
      list.querySelectorAll('.brand-logo-file-input').forEach(input => {
        input.addEventListener('change', event => {
          const file = event.target.files[0];
          if (file) uploadBrandLogo(input.dataset.brandInput, file);
          event.target.value = '';
        });
      });
    }

    async function addCustomBrand(brandName) {
      const trimmed = brandName.trim();
      if (!trimmed) return;
      if (KNOWN_BRANDS.includes(trimmed) || findBrandEntry(trimmed)) {
        showToast('這個品牌已經在清單裡了');
        return;
      }
      try {
        await db.collection('brandShowcase').add({
          brand: trimmed,
          logoUrl: '',
          enabled: false,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        showToast(`已新增品牌「${trimmed}」，可以上傳 Logo 並加入 WE CARRY`);
      } catch (error) {
        console.error(error);
        showToast('新增品牌失敗，請再試一次');
      }
    }

    async function removeBrand(brand) {
      const entry = findBrandEntry(brand);
      if (!entry) return;
      if (!confirm(`確定要移除品牌「${brand}」嗎？這只會移除 WE CARRY 展示設定，不影響已上架的商品。`)) return;
      try {
        await db.collection('brandShowcase').doc(entry[0]).delete();
        showToast('已移除品牌');
      } catch (error) {
        console.error(error);
        showToast('移除失敗，請再試一次');
      }
    }

    async function toggleBrandEnabled(brand, currentlyEnabled) {
      try {
        const entry = findBrandEntry(brand);
        if (entry) {
          await db.collection('brandShowcase').doc(entry[0]).update({
            enabled: !currentlyEnabled,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        } else {
          // 固定6大品牌第一次被啟用時，該品牌還沒有對應文檔，直接建立一筆新的
          await db.collection('brandShowcase').add({
            brand,
            logoUrl: '',
            enabled: true,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }
        showToast(!currentlyEnabled ? '已加入 WE CARRY 露出' : '已從 WE CARRY 移除');
      } catch (error) {
        console.error(error);
        showToast('操作失敗，請再試一次');
      }
    }

    async function uploadBrandLogo(brand, file) {
      try {
        showToast('Logo 上傳中...');
        const { signature, timestamp, apiKey } = await getCloudinarySignature();

        const formData = new FormData();
        formData.append('file', file);
        formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
        formData.append('api_key', apiKey);
        formData.append('timestamp', timestamp);
        formData.append('signature', signature);

        const response = await fetch(CLOUDINARY_UPLOAD_URL, { method: 'POST', body: formData });
        if (!response.ok) {
          throw new Error('Logo 上傳失敗，請檢查網路後再試一次');
        }
        const data = await response.json();

        const entry = findBrandEntry(brand);
        if (entry) {
          await db.collection('brandShowcase').doc(entry[0]).update({
            logoUrl: data.secure_url,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        } else {
          await db.collection('brandShowcase').add({
            brand,
            logoUrl: data.secure_url,
            enabled: false,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }

        showToast('Logo 已更新');
      } catch (error) {
        console.error(error);
        showToast(error.message || 'Logo 上傳失敗，請再試一次');
      }
    }

    // ===== 編輯商品邏輯 =====
    function bindEditProductModal() {
      $('#editProductCancelButton').addEventListener('click', closeEditModal);
      $('#editProductForm').addEventListener('submit', handleEditSubmit);

      $('#editProductBrand').addEventListener('change', event => {
        const isOther = event.target.value === '其他';
        $('#editOtherBrandLabel').hidden = !isOther;
        $('#editOtherBrandInput').required = isOther;
        if (!isOther) $('#editOtherBrandInput').value = '';
      });

      $('#editBagType').addEventListener('change', event => {
        const isOther = event.target.value === '其他';
        $('#editOtherBagTypeLabel').hidden = !isOther;
        $('#editOtherBagTypeInput').required = isOther;
        if (!isOther) $('#editOtherBagTypeInput').value = '';
      });
    }

    function openEditModal(productId) {
      const product = allProducts.find(p => p.id === productId);
      if (!product) return;

      currentProductIdForEdit = productId;

      $('#editProductNo').value = getProductNo(product);

      const isKnownBrand = KNOWN_BRANDS.includes(product.brand);
      $('#editProductBrand').value = isKnownBrand ? product.brand : '其他';
      $('#editOtherBrandLabel').hidden = isKnownBrand;
      $('#editOtherBrandInput').required = !isKnownBrand;
      $('#editOtherBrandInput').value = isKnownBrand ? '' : (product.brand || '');

      const currentBagType = product.bagType || '';
      const isKnownBagType = KNOWN_BAG_TYPES.includes(currentBagType);
      const isCustomBagType = currentBagType && !isKnownBagType;
      $('#editBagType').value = isCustomBagType ? '其他' : currentBagType;
      $('#editOtherBagTypeLabel').hidden = !isCustomBagType;
      $('#editOtherBagTypeInput').required = isCustomBagType;
      $('#editOtherBagTypeInput').value = isCustomBagType ? currentBagType : '';

      $('#editProductName').value = product.name || '';
      $('#editProductSubtitle').value = product.subtitle || '';
      $('#editProductCondition').value = product.condition || '';
      $('#editProductPrice').value = product.price || 0;

      currentEditImages = Array.isArray(product.images) ? [...product.images] : [];
      renderEditImageList();

      $('#editProductModal').classList.add('show');
    }

    function closeEditModal() {
      $('#editProductModal').classList.remove('show');
      currentProductIdForEdit = null;
      currentEditImages = [];
    }

    // 渲染編輯視窗中的圖片縮圖列表，並綁定「刪除」與「拖曳排序」行為
    function renderEditImageList() {
      const container = $('#editImageList');

      if (!currentEditImages.length) {
        container.innerHTML = '<small style="color:#999;">尚無圖片，請點擊下方「新增圖片」</small>';
        return;
      }

      container.innerHTML = currentEditImages.map((url, index) => `
        <div class="edit-image-item${index === 0 ? ' cover' : ''}" draggable="true" data-index="${index}">
          <img src="${url}" alt="商品圖片 ${index + 1}">
          ${index === 0 ? '<span class="cover-badge">封面</span>' : ''}
          <button type="button" class="remove-btn" data-index="${index}" title="刪除這張圖">✕</button>
        </div>
      `).join('');

      // 刪除按鈕：從陣列移除該張圖片後重新渲染
      container.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const index = Number(btn.dataset.index);
          currentEditImages.splice(index, 1);
          renderEditImageList();
        });
      });

      // 拖曳排序：用原生 HTML5 Drag and Drop，不需額外套件
      let dragSrcIndex = null;

      container.querySelectorAll('.edit-image-item').forEach(item => {
        item.addEventListener('dragstart', () => {
          dragSrcIndex = Number(item.dataset.index);
          item.classList.add('dragging');
        });

        item.addEventListener('dragend', () => {
          item.classList.remove('dragging');
        });

        item.addEventListener('dragover', event => {
          event.preventDefault(); // 必須阻止預設行為，否則不會觸發 drop
        });

        item.addEventListener('drop', event => {
          event.preventDefault();
          const targetIndex = Number(item.dataset.index);
          if (dragSrcIndex === null || dragSrcIndex === targetIndex) return;

          const [movedUrl] = currentEditImages.splice(dragSrcIndex, 1);
          currentEditImages.splice(targetIndex, 0, movedUrl);
          dragSrcIndex = null;
          renderEditImageList();
        });
      });
    }

    async function handleEditSubmit(event) {
      event.preventDefault();
      if (!currentProductIdForEdit) return;

      const productNo = $('#editProductNo').value.trim();
      const isDuplicate = allProducts.some(item =>
        item.id !== currentProductIdForEdit &&
        (item.productNo || '').toLowerCase() === productNo.toLowerCase()
      );
      if (isDuplicate) {
        showToast('此商品編號已被使用，請換一個');
        return;
      }

      let finalBrand = $('#editProductBrand').value;
      if (finalBrand === '其他') {
        finalBrand = $('#editOtherBrandInput').value.trim() || '其他';
      }

      let finalBagType = $('#editBagType').value;
      if (finalBagType === '其他') {
        finalBagType = $('#editOtherBagTypeInput').value.trim() || '未分類';
      } else if (!finalBagType) {
        finalBagType = '未分類';
      }

      const submitButton = $('#editProductForm').querySelector('button[type="submit"]');
      submitButton.disabled = true;

      const updatedData = {
        productNo,
        brand: finalBrand,
        bagType: finalBagType,
        name: $('#editProductName').value.trim(),
        subtitle: $('#editProductSubtitle').value.trim(),
        condition: $('#editProductCondition').value.trim(),
        price: Number($('#editProductPrice').value)
      };

      try {
        await db.collection('products').doc(currentProductIdForEdit).update(updatedData);
        showToast('商品資訊已更新');
        closeEditModal();
      } catch (error) {
        console.error(error);
        showToast('更新失敗，請再試一次');
      } finally {
        submitButton.disabled = false;
      }
    }

    // ===== 訂單管理 =====
    function bindOrderEvents() {
      $('#manualOrderForm').addEventListener('submit', handleManualOrderSubmit);
      $('#orderMemberSearchInput').addEventListener('input', handleMemberSearchInput);
      $('#orderMemberClearButton').addEventListener('click', clearSelectedMember);

      $$('.order-filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          orderStatusFilter = chip.dataset.status;
          $$('.order-filter-chip').forEach(item => item.classList.toggle('active', item === chip));
          orderListExpanded = false;
          renderOrderList();
        });
      });

      $('#orderExpandButton').addEventListener('click', () => {
        orderListExpanded = !orderListExpanded;
        renderOrderList();
      });

      // 🛠 新增：綁定「已完成歷史訂單」展開按鈕事件
      $('#historyExpandButton').addEventListener('click', () => {
        historyListExpanded = !historyListExpanded;
        renderHistoryOrderList();
      });
    }

    async function loadAllMembers() {
      try {
        const snapshot = await db.collection('users').get();
        allMembers = snapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() }));
        renderOrderList(); 
        renderHistoryOrderList(); // 重新渲染確保歷史訂單的名字也是最新的
      } catch (error) {
        console.error('載入會員清單失敗：', error);
        allMembers = [];
      }
    }

    function handleMemberSearchInput(event) {
      const keyword = event.target.value.trim().toLowerCase();
      const resultsBox = $('#orderMemberResults');

      if (!keyword) {
        resultsBox.hidden = true;
        resultsBox.innerHTML = '';
        return;
      }

      const matches = allMembers.filter(member => {
        const name = (member.displayName || '').toLowerCase();
        const email = (member.email || '').toLowerCase();
        return name.includes(keyword) || email.includes(keyword);
      }).slice(0, 8); 

      if (matches.length === 0) {
        resultsBox.hidden = false;
        resultsBox.innerHTML = '<div class="member-search-empty">找不到符合的會員，可繼續輸入或留空建立現場客人訂單</div>';
        return;
      }

      resultsBox.hidden = false;
      resultsBox.innerHTML = matches.map(member => `
        <button type="button" class="member-result-item" data-uid="${escapeHtml(member.uid)}">
          <strong>${escapeHtml(member.displayName) || '（未設定姓名）'}</strong>
          <span>${escapeHtml(member.email)}</span>
        </button>
      `).join('');

      resultsBox.querySelectorAll('.member-result-item').forEach(button => {
        button.addEventListener('click', () => {
          const member = allMembers.find(item => item.uid === button.dataset.uid);
          if (member) selectMemberForOrder(member);
        });
      });
    }

    function selectMemberForOrder(member) {
      selectedMemberForOrder = member;

      $('#orderMemberSearchInput').value = '';
      $('#orderMemberResults').hidden = true;
      $('#orderMemberResults').innerHTML = '';

      $('#orderMemberSelectedText').textContent = `已綁定會員：${member.displayName || member.email || member.uid}`;
      $('#orderMemberSelected').hidden = false;

      const customerInput = $('#orderCustomerInput');
      if (!customerInput.value.trim()) {
        customerInput.value = member.displayName || '';
      }
    }

    function clearSelectedMember() {
      selectedMemberForOrder = null;
      $('#orderMemberSelected').hidden = true;
      $('#orderMemberSelectedText').textContent = '';
    }

    function renderOrderProductOptions(products) {
      const select = $('#orderProductSelect');
      const activeProducts = products.filter(product => product.status !== 'sold');
      const currentValue = select.value;

      select.innerHTML = '<option value="" disabled selected>請選擇商品</option>' +
        activeProducts.map(product => (
          `<option value="${escapeHtml(product.id)}">${escapeHtml(product.brand)} - ${escapeHtml(product.name)}（NT$ ${Number(product.price || 0).toLocaleString('zh-TW')}）</option>`
        )).join('');

      if (currentValue && activeProducts.some(p => p.id === currentValue)) {
        select.value = currentValue;
      }
    }

    async function handleManualOrderSubmit(event) {
      event.preventDefault();

      const productId = $('#orderProductSelect').value;
      const product = allProducts.find(item => item.id === productId);
      if (!product) {
        showToast('請選擇商品');
        return;
      }

      const customerName = $('#orderCustomerInput').value.trim();
      const lineId = $('#orderLineIdInput').value.trim();
      const phone = $('#orderPhoneInput').value.trim();

      const contactParts = [];
      if (lineId) contactParts.push(`LINE: ${lineId}`);
      if (phone) contactParts.push(`電話: ${phone}`);
      const contact = contactParts.join(' ');

      try {
        await db.collection('orders').add({
          productId: product.id,
          productNo: getProductNo(product),
          productName: product.name || '',
          productBrand: product.brand || '',
          price: Number(product.price || 0),
          imageUrl: getProductImage(product),
          customerName,
          lineId,
          phone,
          contact,
          userId: selectedMemberForOrder ? selectedMemberForOrder.uid : null,
          userEmail: selectedMemberForOrder ? (selectedMemberForOrder.email || '') : '',
          status: 'pending',
          source: 'manual',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        showToast(selectedMemberForOrder ? '訂單已建立並綁定會員' : '訂單已建立（現場客人，未綁定會員）');
        $('#manualOrderForm').reset();
        clearSelectedMember();
      } catch (error) {
        console.error(error);
        showToast('建立訂單失敗，請再試一次');
      }
    }

    function listenToOrders() {
      db.collection('orders')
        .onSnapshot(snapshot => {
          allOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

          // 改成在前端排序，避免 Firestore orderBy 把缺少 createdAt 欄位的舊訂單直接排除在查詢結果外
          allOrders.sort((a, b) => {
            const aTime = a.createdAt ? a.createdAt.toMillis() : 0;
            const bTime = b.createdAt ? b.createdAt.toMillis() : 0;
            return bTime - aTime;
          });

          renderOrderList();
          renderCancelledOrderList();
          renderHistoryOrderList();
        }, error => {
          console.error('讀取訂單失敗：', error);
        });
    }

    function renderOrderList() {
      const baseFiltered = allOrders.filter(order => order.status !== 'completed' && order.status !== 'cancelled');
      
      const filtered = orderStatusFilter === 'all'
        ? baseFiltered
        : baseFiltered.filter(order => order.status === orderStatusFilter);

      $('#orderCount').textContent = baseFiltered.length;

      const list = $('#orderList');
      const hiddenList = $('#orderListHidden');
      const expandButton = $('#orderExpandButton');

      if (!filtered.length) {
        list.innerHTML = '<p class="empty">目前沒有符合條件的訂單。</p>';
        hiddenList.innerHTML = '';
        expandButton.hidden = true;
        return;
      }

      const visibleOrders = filtered.slice(0, 5);
      const hiddenOrders = filtered.slice(5);

      list.innerHTML = visibleOrders.map(order => createOrderCardHTML(order)).join('');
      attachOrderEventListeners(list);

      if (hiddenOrders.length > 0) {
        if (orderListExpanded) {
          hiddenList.innerHTML = hiddenOrders.map(order => createOrderCardHTML(order)).join('');
          hiddenList.classList.add('show');
          expandButton.textContent = '收起訂單';
        } else {
          hiddenList.innerHTML = '';
          hiddenList.classList.remove('show');
          expandButton.textContent = `展開更多訂單（${hiddenOrders.length}）`;
        }
        expandButton.hidden = false;
        attachOrderEventListeners(hiddenList);
      } else {
        hiddenList.innerHTML = '';
        hiddenList.classList.remove('show');
        expandButton.hidden = true;
      }
    }

    function renderCancelledOrderList() {
      const cancelledOrders = allOrders.filter(order => order.status === 'cancelled');
      $('#cancelledOrderCount').textContent = cancelledOrders.length;
      const list = $('#cancelledOrderList');

      if (!cancelledOrders.length) {
        list.innerHTML = '<p class="empty">目前沒有已取消訂單。</p>';
        return;
      }

      list.innerHTML = cancelledOrders.map(order => createOrderCardHTML(order)).join('');
      attachOrderEventListeners(list);
    }

    // 🛠 已修改：歷史訂單（已完成訂單）只顯示 5 筆，其餘可點擊展開
    function renderHistoryOrderList() {
      const historyOrders = allOrders.filter(order => order.status === 'completed');
      $('#historyOrderCount').textContent = historyOrders.length;
      
      const list = $('#historyOrderList');
      const hiddenList = $('#historyOrderListHidden');
      const expandButton = $('#historyExpandButton');

      if (!historyOrders.length) {
        list.innerHTML = '<p class="empty">目前沒有已完成訂單。</p>';
        hiddenList.innerHTML = '';
        expandButton.hidden = true;
        return;
      }

      // 切割前 5 筆與其餘筆數
      const visibleHistory = historyOrders.slice(0, 5);
      const hiddenHistory = historyOrders.slice(5);

      list.innerHTML = visibleHistory.map(order => createOrderCardHTML(order)).join('');
      attachOrderEventListeners(list);

      if (hiddenHistory.length > 0) {
        if (historyListExpanded) {
          hiddenList.innerHTML = hiddenHistory.map(order => createOrderCardHTML(order)).join('');
          hiddenList.classList.add('show');
          expandButton.textContent = '收起歷史訂單';
        } else {
          hiddenList.innerHTML = '';
          hiddenList.classList.remove('show');
          expandButton.textContent = `展開更多已完成訂單（${hiddenHistory.length}）`;
        }
        expandButton.hidden = false;
        attachOrderEventListeners(hiddenList);
      } else {
        hiddenList.innerHTML = '';
        hiddenList.classList.remove('show');
        expandButton.hidden = true;
      }
    }

    function formatOrderTime(timestamp) {
      if (!timestamp || typeof timestamp.toDate !== 'function') return '';
      const date = timestamp.toDate();
      const pad = (num) => String(num).padStart(2, '0');
      const y = date.getFullYear();
      const m = pad(date.getMonth() + 1);
      const d = pad(date.getDate());
      const hh = pad(date.getHours());
      const mm = pad(date.getMinutes());
      return `${y}/${m}/${d} ${hh}:${mm}`;
    }

    function createOrderCardHTML(order) {
      const statusLabel = ORDER_STATUS_LABELS[order.status] || order.status;
      const orderTimeLabel = formatOrderTime(order.createdAt);
      const sourceLabel = order.source === 'manual' ? '後台手動建立' : '客人線上下單';
      const contactLine = order.userEmail || order.contact
        ? `<span>聯絡方式：${escapeHtml(order.userEmail || order.contact)}</span>`
        : '';
      const transactionData = order.transactionData;
      const transactionInfo = transactionData ? `<span style="color: var(--green);">✓ 已記錄交易資訊</span>` : '';

      return `
      <article class="admin-order-card status-${order.status}">
        ${order.imageUrl ? `<img src="${escapeHtml(order.imageUrl)}" alt="${escapeHtml(order.productName)}">` : `<span class="no-image">無圖片</span>`}
        <div class="admin-order-info">
          <small>${escapeHtml(order.productBrand)} · NO. ${escapeHtml(order.productNo)} · ${sourceLabel}</small>
          <strong>${escapeHtml(order.productName)}</strong>
          <span>NT$ ${Number(order.price || 0).toLocaleString('zh-TW')}</span>
          <span>客人：${escapeHtml(getOrderCustomerName(order))}</span>
          ${orderTimeLabel ? `<span>下單時間：${escapeHtml(orderTimeLabel)}</span>` : ''}
          ${contactLine}
          ${transactionInfo}
          <em class="status-label"><span class="status-dot dot-${order.status}"></span>${statusLabel}</em>
        </div>
        <div class="admin-order-actions">
          <div class="order-status-row">
            <label class="order-status-label" for="order-status-${escapeHtml(order.id)}">訂單狀態：</label>
            <select id="order-status-${escapeHtml(order.id)}" data-action="order-status" data-id="${escapeHtml(order.id)}">
              <option value="pending" ${order.status === 'pending' ? 'selected' : ''}>處理中</option>
              <option value="confirmed" ${order.status === 'confirmed' ? 'selected' : ''}>已確認</option>
              <option value="unpaid" ${order.status === 'unpaid' ? 'selected' : ''}>未付款</option>
              <option value="preparing" ${order.status === 'preparing' ? 'selected' : ''}>待出貨</option>
              <option value="shipping" ${order.status === 'shipping' ? 'selected' : ''}>寄送中</option>
              <option value="arrived" ${order.status === 'arrived' ? 'selected' : ''}>已送達指定地點</option>
              <option value="completed" ${order.status === 'completed' ? 'selected' : ''}>已完成</option>
              <option value="cancelled" ${order.status === 'cancelled' ? 'selected' : ''}>已取消</option>
            </select>
          </div>
          <button type="button" data-action="order-transaction" data-id="${order.id}" style="background: var(--slate); color: white; padding: 8px 12px; border: none; border-radius: 4px; cursor: pointer;">填寫交易資訊</button>
        </div>
        <div class="order-delete-hint">無法從後台刪除訂單紀錄<br>若真的要取消，請至 Firebase → Firestore → orders 找到該訂單刪除</div>
      </article>
    `;
    }

    function attachOrderEventListeners(container) {
      container.querySelectorAll('[data-action="order-status"]').forEach(select => {
        select.addEventListener('change', () => updateOrderStatus(select.dataset.id, select.value));
      });
      container.querySelectorAll('[data-action="order-transaction"]').forEach(button => {
        button.addEventListener('click', () => {
          const order = allOrders.find(o => o.id === button.dataset.id);
          if (order) openTransactionModal(button.dataset.id, order);
        });
      });
    }

    async function updateOrderStatus(id, status) {
      try {
        const updateData = { status };

        // 只有當狀態變成「已完成」時，記錄下這個時間點，供交易紀錄同步使用
        if (status === 'completed') {
          updateData.completedAt = firebase.firestore.FieldValue.serverTimestamp();
        }

        await db.collection('orders').doc(id).update(updateData);
        showToast('訂單狀態已更新');
      } catch (error) {
        console.error(error);
        showToast('更新失敗，請再試一次');
      }
    }

    function showToast(message) {
      const toast = $('#toast');
      toast.textContent = message;
      toast.classList.add('show');
      window.clearTimeout(showToast.timer);
      showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2400);
    }

    document.addEventListener('DOMContentLoaded', init);