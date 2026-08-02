// ===== Firebase 設定 =====
    const firebaseConfig = {
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

    const LINE_ID = '@obb0550c';

    let PRODUCTS = [];
    // WE CARRY 品牌展示資料，與商品庫存完全脫鉤，來源為後台獨立的品牌管理頁面
    let BRAND_SHOWCASE = {};

    const state = {
      brand: '全部',
      bagType: '全部',
      keyword: '',
      currentProduct: null,
      currentImage: ''
    };

    const memberState = {
      user: null,           
      favoriteIds: new Set(), 
      favoritesUnsub: null,
      ordersUnsub: null
    };

    // 註冊當下填寫的 LINE ID／電話會先暫存在這裡，等 ensureUserDocument 第一次建立
    // 會員文件時一併寫入（因為這是 create，不是 update，才符合 Firestore 規則的白名單）。
    // 用完（文件建立成功後）就會清空，避免影響之後任何其他登入流程。
    let pendingRegistrationContact = null;

    const $ = selector => document.querySelector(selector);
    const $$ = selector => Array.from(document.querySelectorAll(selector));
    const money = value => 'NT$ ' + Number(value).toLocaleString('zh-TW');

    function escapeHtml(text) {
      return String(text ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[char]));
    }

    // ===== 圖片正規化（根本解決裁切/跑版問題） =====
    // 不管後台上傳的原始照片比例、構圖為何（直的、橫的、包包偏一角...），
    // 統一透過 Cloudinary 轉換參數輸出固定規格的圖片，讓前端顯示永遠一致。
    // 之後新增商品完全不需要額外處理，所有圖片會自動套用同一套規則。
    // 非 Cloudinary 圖片（例如本地 placeholder.png）會原樣返回，不受影響。
    function cldUrl(url, opts = {}) {
      if (!url || typeof url !== 'string' || !url.includes('res.cloudinary.com') || !url.includes('/upload/')) {
        return url;
      }
      const { width, crop, ar, gravity, background = 'rgb:fbf7f0' } = opts;
      const parts = ['f_auto', 'q_auto'];
      if (crop) parts.push(`c_${crop}`);
      if (ar) parts.push(`ar_${ar}`);
      if (gravity) parts.push(`g_${gravity}`);
      if (width) parts.push(`w_${width}`);
      if (crop === 'pad') parts.push(`b_${background}`);
      return url.replace('/upload/', `/upload/${parts.join(',')}/`);
    }

    // 縮圖／商品卡片：正方形、留白補滿背景色，網格排列永遠整齊
    const cldThumb = url => cldUrl(url, { crop: 'pad', ar: '1:1', width: 240 });
    const cldGrid = url => cldUrl(url, { crop: 'pad', ar: '1:1', width: 500 });
    // 主圖／燈箱：保留原始比例，只限制最大尺寸與優化格式，完整顯示整張照片
    const cldMain = url => cldUrl(url, { crop: 'limit', width: 1600 });
    // Hero 輪播：維持橫幅區塊比例，但用 pad 補滿背景色而非裁切，
    // 確保商品照片完整顯示、不會被切掉任何部分
    const cldHero = url => cldUrl(url, { crop: 'pad', ar: '2.1', width: 1200 });

    const BRAND_ALIASES = {
      'Louis Vuitton': ['LV', 'L.V.', 'L V', 'Louis', 'Louis Vuitton', '路易威登', 'lv'],
      Chanel: ['CHANEL', 'Coco Chanel', '香奈兒', 'chanel'],
      Hermes: ['Hermes', 'Hermès', 'HERMES', '愛馬仕', 'hermes'],
      Gucci: ['GUCCI', '古馳','gucci'],
      Prada: ['PRADA', '普拉達','prada'],
      Burberry: ['BURBERRY', '巴寶莉', 'burberry']
    };

    let brands = ['全部'];
    let bagTypes = ['全部'];

    function init() {
      bindEvents();
      bindMemberEvents();
      listenToProducts();
      listenToBrandShowcase();
      listenToAuthState();
    }

    function getProductImages(data) {
      if (Array.isArray(data.images) && data.images.length) {
        return data.images;
      }
      if (data.imgSrc) {
        return [data.imgSrc];
      }
      return ['images/placeholder.png'];
    }

    function listenToProducts() {
      db.collection('products')
        .where('status', '==', 'active')
        .orderBy('createdAt', 'desc')
        .onSnapshot(snapshot => {
          PRODUCTS = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
              id: doc.id,
              productNo: data.productNo || '',
              brand: data.brand || '',
              bagType: data.bagType || '未分類',
              name: data.name || '',
              subtitle: data.subtitle || '',
              condition: data.condition || '',
              price: data.price || 0,
              images: getProductImages(data),
              showInHero: !!data.showInHero
            };
          });

          brands = ['全部', ...new Set(PRODUCTS.map(product => product.brand))];
          bagTypes = ['全部', ...new Set(PRODUCTS.map(product => product.bagType))];

          renderFilters();
          renderTypeFilters();
          renderProducts();
          renderNavBrandMenu();
          initHeroCarousel();
          openFromQuery();
        }, error => {
          console.error('讀取商品時發生錯誤：', error);
          $('#productGrid').innerHTML = '<p class="empty">商品資料讀取失敗，請稍後再試。</p>';
        });
    }

    function bindEvents() {
      $('#menuButton').addEventListener('click', toggleMenu);
      $('#searchButton').addEventListener('click', () => {
        showPage('list');
        setTimeout(() => {
          document.querySelector('#products').scrollIntoView({ behavior: 'smooth' });
          $('#searchInput').focus();
        }, 50);
      });
      $('#searchInput').addEventListener('input', event => {
        state.keyword = normalizeSearchText(event.target.value);
        state.brand = '全部'; // 搜尋欄輸入時，視為全站搜尋，重置品牌篩選避免疊加限制
        state.bagType = '全部';
        renderFilters();
        renderTypeFilters();
        renderProducts();
      });
      $('#backButton').addEventListener('click', () => showPage('list'));
      
      // 已移除：舊輪播箭頭與按鈕的事件綁定
      
      $('#copyButton').addEventListener('click', copyProductLink);
      $('#mainImageButton').addEventListener('click', openLightbox);
      $('#closeLightbox').addEventListener('click', closeLightbox);
      $('#lightbox').addEventListener('click', event => {
        if (event.target.id === 'lightbox') closeLightbox();
      });
      $$('[data-line]').forEach(button => button.addEventListener('click', openLine));
      $$('[data-page="list"]').forEach(link => link.addEventListener('click', event => {
        event.preventDefault();
        
        state.brand = '全部';
        state.bagType = '全部';
        state.keyword = '';
        const searchInput = $('#searchInput');
        if (searchInput) searchInput.value = '';
        renderFilters();
        renderTypeFilters();
        renderProducts();

        const wasOnList = !$('#pageList').hidden;
        showPage('list');
        const targetSelector = link.dataset.scrollTarget;
        if (targetSelector) {
          const targetEl = document.querySelector(targetSelector);
          if (targetEl) {
            if (wasOnList) {
              targetEl.scrollIntoView({ behavior: 'smooth' });
            } else {
              setTimeout(() => targetEl.scrollIntoView({ behavior: 'smooth' }), 50);
            }
          }
        }
      }));
      $$('.tab-button').forEach(button => {
        button.addEventListener('click', () => switchTab(button.dataset.tab));
      });
      $('#memberButton').addEventListener('click', () => showPage('member'));
      $('#mobileMemberButton').addEventListener('click', () => showPage('member'));
      $('#storeInfoButton').addEventListener('click', () => showPage('store'));
      $('#mobileStoreInfoButton').addEventListener('click', () => showPage('store'));
      $('#storeBackButton').addEventListener('click', () => showPage('list'));
      $('#memberBackButton').addEventListener('click', () => showPage('list'));
      $('#detailFavoriteButton').addEventListener('click', toggleCurrentProductFavorite);
      $('#detailBuyButton').addEventListener('click', submitOrderForCurrentProduct);
    }

    // 已修改：Swiper 實例儲存與動態初始化邏輯
    let myHeroSwiper = null;

    function initHeroCarousel() {
      if (myHeroSwiper) {
        myHeroSwiper.destroy(true, true);
        myHeroSwiper = null;
      }

      const heroProducts = PRODUCTS.filter(p => p.showInHero);
      const wrapper = $('#heroSwiperWrapper');

      if (!heroProducts.length) {
        $('.hero').hidden = true;
        return;
      }
      $('.hero').hidden = false;

      // 動態渲染多張 Slide
      wrapper.innerHTML = heroProducts.map(product => `
        <div class="swiper-slide">
          <button type="button" class="hero-slide-btn" onclick="openProductDetail('${product.id}')" aria-label="查看 ${escapeHtml(product.name)} 詳情">
            <img src="${escapeHtml(cldHero(product.images[0]))}" alt="${escapeHtml(product.name)}" />
          </button>
          <div class="hero-slide-card">
            <span>本週主打</span>
            <strong>${escapeHtml(product.name)}</strong>
            <b>${money(product.price)}</b>
          </div>
        </div>
      `).join('');

      // 初始化 Swiper 實例
      myHeroSwiper = new Swiper(".heroSwiper", {
        loop: true,
        centeredSlides: true,
        slidesPerView: "auto",
        spaceBetween: 20,
        autoplay: {
          delay: 6000,
          disableOnInteraction: false,
        },
        pagination: {
          el: ".hero-container-wrapper .swiper-pagination",
          clickable: true,
        },
        navigation: {
          nextEl: ".hero-container-wrapper .hero-swiper-next",
          prevEl: ".hero-container-wrapper .hero-swiper-prev",
        },
      });
    }

    function renderNavBrandMenu() {
      const inner = document.querySelector('#navBrandMenu .nav-dropdown-menu-inner');
      if (!inner) return;
      const items = ['全部', ...new Set(PRODUCTS.map(p => p.brand))];
      inner.innerHTML = items.map(brand => (
        `<button type="button" data-brand="${escapeHtml(brand)}">${brand === '全部' ? '所有商品' : escapeHtml(brand)}</button>`
      )).join('');
      inner.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
          const brand = btn.dataset.brand;
          state.brand = brand;
          
          const searchInput = $('#searchInput');
          if (brand === '全部') {
            state.keyword = '';
            if (searchInput) searchInput.value = '';
          } else {
            state.keyword = brand;
            if (searchInput) searchInput.value = brand;
          }

          state.bagType = '全部';

          showPage('list'); 
          renderFilters();
          renderTypeFilters();
          renderProducts();
          
          setTimeout(() => {
            const targetEl = document.querySelector('#products');
            if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth' });
          }, 50);
        });
      });
    }

    function renderFilters() {
      $('#filterBar').innerHTML = brands.map(brand => (
        `<button type="button" class="filter-chip ${brand === state.brand ? 'active' : ''}" data-brand="${escapeHtml(brand)}">${escapeHtml(brand)}</button>`
      )).join('');
      $$('#filterBar .filter-chip').forEach(button => {
        button.addEventListener('click', () => {
          state.brand = button.dataset.brand;
          renderFilters();
          renderProducts();
        });
      });
    }

    function renderTypeFilters() {
      $('#filterBarType').innerHTML = bagTypes.map(type => (
        `<button type="button" class="filter-chip ${type === state.bagType ? 'active' : ''}" data-type="${escapeHtml(type)}">${escapeHtml(type)}</button>`
      )).join('');
      $$('#filterBarType .filter-chip').forEach(button => {
        button.addEventListener('click', () => {
          state.bagType = button.dataset.type;
          renderTypeFilters();
          renderProducts();
        });
      });
    }

    function listenToBrandShowcase() {
      db.collection('brandShowcase')
        .onSnapshot(snapshot => {
          BRAND_SHOWCASE = {};
          snapshot.docs.forEach(doc => {
            const data = doc.data();
            if (data && data.brand) {
              BRAND_SHOWCASE[data.brand] = { ...data, _docId: doc.id };
            }
          });
          renderBrands();
        }, error => {
          console.error('讀取品牌展示資料時發生錯誤：', error);
        });
    }

    function renderBrands() {
      // 只顯示後台品牌管理頁面標記為 enabled 的品牌，與商品上下架完全脫鉤
      const enabledBrands = Object.keys(BRAND_SHOWCASE).filter(brand => BRAND_SHOWCASE[brand] && BRAND_SHOWCASE[brand].enabled);

      const wrap = $('#brandsMarqueeWrap');

      if (!enabledBrands.length) {
        $('#brandRow').innerHTML = '';
        wrap.classList.remove('is-scrolling');
        return;
      }

      const cardHtml = enabledBrands.map(brand => {
        const logoUrl = BRAND_SHOWCASE[brand].logoUrl || '';
        const letter = brand.charAt(0).toUpperCase();
        return `
        <button type="button" class="brand-card" data-brand="${escapeHtml(brand)}">
          ${logoUrl
            ? `<span class="brand-card-image"><img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(brand)}" loading="lazy"></span>`
            : `<span class="brand-card-image brand-card-image--empty"><span class="brand-card-letter">${escapeHtml(letter)}</span></span>`}
          <span class="brand-card-name">${escapeHtml(brand.toUpperCase())}</span>
        </button>
      `;
      }).join('');

      // 品牌數量夠多時才啟用無縫緩慢滾動：內容複製一份接在後面，
      // 動畫跑到 -50% 剛好等於跑完第一份，無痕接上第二份形成循環。
      // 品牌太少（<=3）滾動起來會太快看起來像故障，所以少於等於 3 個時維持靜態排列。
      const shouldScroll = enabledBrands.length > 3;
      wrap.classList.toggle('is-scrolling', shouldScroll);
      $('#brandRow').innerHTML = shouldScroll ? (cardHtml + cardHtml) : cardHtml;

      $$('#brandRow .brand-card').forEach(button => {
        button.addEventListener('click', () => {
          state.brand = button.dataset.brand;
          state.bagType = '全部';
          renderFilters();
          renderTypeFilters();
          renderProducts();
          document.querySelector('#products').scrollIntoView({ behavior: 'smooth' });
        });
      });
    }

    function getFilteredProducts() {
      return PRODUCTS.filter(product => {
        const matchBrand = state.brand === '全部' || product.brand === state.brand;
        const matchType = state.bagType === '全部' || product.bagType === state.bagType;
        const matchKeyword = !state.keyword || matchesKeyword(product, state.keyword);
        return matchBrand && matchType && matchKeyword;
      });
    }

    function matchesKeyword(product, keyword) {
      const fields = [
        product.brand,
        product.bagType,
        product.name,
        product.subtitle,
        product.condition,
        ...(BRAND_ALIASES[product.brand] || [])
      ];
      const normalizedFields = fields.map(normalizeSearchText);
      const compactKeyword = compactSearchText(keyword);
      const compactFields = normalizedFields.map(compactSearchText);
      const tokens = normalizedFields.flatMap(text => text.split(' ').filter(Boolean));

      if (compactKeyword.length <= 2) {
        return normalizedFields.some(text => text === keyword)
          || tokens.some(token => token === keyword)
          || compactFields.some(text => text.startsWith(compactKeyword));
      }

      return normalizedFields.some(text => text.includes(keyword))
        || compactFields.some(text => text.includes(compactKeyword));
    }

    function normalizeSearchText(text) {
      return String(text || '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\s、｜|／\/_.-]+/g, ' ')
        .trim();
    }

    function compactSearchText(text) {
      return normalizeSearchText(text).replace(/\s+/g, '');
    }

    function renderProducts() {
      const products = getFilteredProducts();
      const grid = $('#productGrid');
      if (!products.length) {
        grid.innerHTML = '<p class="empty">目前沒有符合條件的商品。</p>';
        return;
      }
      grid.innerHTML = products.map(product => `
        <article class="product-card">
          <button type="button" data-id="${product.id}" aria-label="查看 ${escapeHtml(product.name)}">
            <span class="product-image"><img src="${escapeHtml(cldGrid(product.images[0]))}" alt="${escapeHtml(product.name)}" loading="lazy"></span>
            <span class="product-meta">
              <small>${escapeHtml(product.brand)}</small>
              <strong>${escapeHtml(product.name)}</strong>
              <em>${escapeHtml(product.condition)}</em>
              <b>${money(product.price)}</b>
            </span>
          </button>
        </article>
      `).join('');
      $$('.product-card button').forEach(button => {
        button.addEventListener('click', () => openProductDetail(button.dataset.id));
      });
    }

    function openProductDetail(id) {
      const product = PRODUCTS.find(item => item.id === id);
      if (!product) return;
      state.currentProduct = product;
      state.currentImage = product.images[0];
      $('#detailBrand').textContent = product.brand.toUpperCase();
      $('#detailName').textContent = product.name;
      $('#detailSubtitle').textContent = product.subtitle;
      $('#detailPrice').textContent = money(product.price);
      $('#specBrand').textContent = product.brand;
      $('#specCondition').textContent = product.condition;
      $('#specId').textContent = product.productNo || product.id;
      $('#descBody').textContent = product.subtitle;
      renderGallery(product);
      switchTab('desc');
      updateFavoriteButtonUI();
      showPage('detail');
      history.replaceState(null, '', `?p=${product.id}`);
    }

    function renderGallery(product) {
      setMainImage(cldMain(product.images[0]), product.name);
      $('#thumbRow').innerHTML = product.images.map((src, index) => `
        <button type="button" class="thumb ${index === 0 ? 'active' : ''}" data-full="${escapeHtml(cldMain(src))}" aria-label="切換到第 ${index + 1} 張圖片">
          <img src="${escapeHtml(cldThumb(src))}" alt="${escapeHtml(product.name)} 圖片 ${index + 1}">
        </button>
      `).join('');
      $$('.thumb').forEach(button => {
        button.addEventListener('click', () => {
          setMainImage(button.dataset.full, product.name);
          $$('.thumb').forEach(item => item.classList.toggle('active', item === button));
        });
      });
    }

    function setMainImage(src, alt) {
      state.currentImage = src;
      $('#mainImage').src = src;
      $('#mainImage').alt = alt;
      $('#lightboxImage').src = src;
      $('#lightboxImage').alt = alt;
    }

    function showPage(page) {
      const isDetail = page === 'detail';
      const isMember = page === 'member';
      const isStore = page === 'store';
      $('#pageList').hidden = isDetail || isMember || isStore;
      $('#pageDetail').hidden = !isDetail;
      $('#pageMember').hidden = !isMember;
      $('#pageStore').hidden = !isStore;
      closeMenu();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (isMember) {
        renderMemberView();
      } else if (!isDetail) {
        history.replaceState(null, '', location.pathname);
      }

      // 修正：從詳情頁等子頁面切回列表頁時，hero 輪播在隱藏期間尺寸計算會跑掉，
      // 導致左右箭頭失效，這裡強制 Swiper 重新計算尺寸並更新狀態
      if (!isDetail && !isMember && !isStore && myHeroSwiper) {
        requestAnimationFrame(() => {
          myHeroSwiper.update();
          myHeroSwiper.updateSlides();
          myHeroSwiper.updateProgress();
          myHeroSwiper.updateSlidesClasses();
        });
      }
    }

    function switchTab(tab) {
      $$('.tab-button').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
      $$('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `tab-${tab}`));
    }

    // ===== 會員系統 =====

    function bindMemberEvents() {
      $$('.auth-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          const target = tab.dataset.authTab;
          $$('.auth-tab').forEach(item => item.classList.toggle('active', item === tab));
          $('#loginFormFront').hidden = target !== 'login';
          $('#registerFormFront').hidden = target !== 'register';
        });
      });

      async function handleForgotPassword() {
        const email = $('#loginEmailInput').value.trim();
        if (!email) {
          showToast('請先在 Email 欄位輸入您的電子信箱');
          return;
        }
        
        try {
          await auth.sendPasswordResetEmail(email);
          showToast('密碼重設信件已寄出，請至信箱查收！');
        } catch (error) {
          console.error('發送重設密碼信失敗：', error);
          if (error.code === 'auth/user-not-found') {
            showToast('找不到此帳號，請確認 Email 是否正確');
          } else {
            showToast('發送失敗，請稍後再試或聯絡客服');
          }
        }
      }

      const forgotBtn = $('#forgotPasswordButton');
      if (forgotBtn) {
        forgotBtn.addEventListener('click', handleForgotPassword);
      }

      $('#loginFormFront').addEventListener('submit', handleLoginSubmit);
      $('#registerFormFront').addEventListener('submit', handleRegisterSubmit);
      $('#memberLogoutButton').addEventListener('click', handleLogout);
      $('#memberNameEditButton').addEventListener('click', startEditMemberName);
      $('#memberNameCancelButton').addEventListener('click', cancelEditMemberName);
      $('#memberNameSaveButton').addEventListener('click', saveMemberName);
      $('#memberNameInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') saveMemberName();
        if (event.key === 'Escape') cancelEditMemberName();
      });

      $$('.member-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          const target = tab.dataset.memberTab;
          $$('.member-tab').forEach(item => item.classList.toggle('active', item === tab));
          $$('.member-tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `memberPanel-${target}`));
        });
      });

      $('#memberOrderAlert').addEventListener('click', () => {
        const ordersTab = document.querySelector('.member-tab[data-member-tab="orders"]');
        if (ordersTab) ordersTab.click();
      });
    }

    function listenToAuthState() {
      auth.onAuthStateChanged(async user => {
        if (user) {
          memberState.user = user;
          await ensureUserDocument(user);
          
          if ($('#navAuthText')) $('#navAuthText').textContent = '會員中心';
          if ($('#menuAuthText')) $('#menuAuthText').textContent = '會員中心';
          
          if (user.photoURL) {
            const avatarHtml = `<img src="${user.photoURL}" alt="avatar" class="nav-avatar" />`;
            if ($('#navAuthText')) $('#navAuthText').innerHTML = avatarHtml;
            if ($('#menuAuthText')) $('#menuAuthText').innerHTML = avatarHtml;
          }

          fetchUserProfile(user.uid);
          listenToOrders(user.uid);
          listenToFavorites(user.uid);

          if (!$('#pageMember').hidden) {
            renderMemberView();
          }

        } else {
          memberState.user = null;
          memberState.profile = null;
          memberState.orderCount = 0;
          
          if (memberState.ordersUnsub) { memberState.ordersUnsub(); memberState.ordersUnsub = null; }
          if (memberState.favoritesUnsub) { memberState.favoritesUnsub(); memberState.favoritesUnsub = null; }

          if ($('#navAuthText')) $('#navAuthText').textContent = '登入 / 註冊';
          if ($('#menuAuthText')) $('#menuAuthText').textContent = '登入 / 註冊';
          
          resetMemberUI();
        }
      });
    }

    function fetchUserProfile(uid) {
      renderMemberSince();
    }

    function resetMemberUI() {
      $('#memberEmailLabel').textContent = '';
      $('#memberAvatar').textContent = '';
      $('#memberSinceLabel').textContent = '';
      $('#favoritesGrid').innerHTML = '';
      $('#ordersList').innerHTML = '';
      $('#memberFavoriteCount').textContent = '0';
      $('#memberOrderCount').textContent = '0';
      $('#memberOrderAlert').hidden = true;
      renderMemberView();
    }

    async function ensureUserDocument(user) {
      if (!user) return;
      const docRef = db.collection('users').doc(user.uid);

      try {
        // 先讀一次確認文件存不存在，不要用錯誤代碼去猜——Firestore 規則對「不存在的文件
        // 呼叫 update()」回傳的其實是 permission-denied，不是 not-found，用錯誤代碼判斷
        // 會導致新帳號的文件永遠建立不起來（首次註冊後的 update 一路失敗、備援建立邏輯
        // 從未被觸發）。改用 get() 判斷 exists 就不會有這個誤判問題。
        const snap = await docRef.get();

        if (snap.exists) {
          await docRef.update({
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        } else {
          const payload = {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || '',
            photoURL: user.photoURL || '',
            contact: '',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          };
          if (pendingRegistrationContact) {
            if (pendingRegistrationContact.lineId) payload.lineId = pendingRegistrationContact.lineId;
            if (pendingRegistrationContact.phone) payload.phone = pendingRegistrationContact.phone;
          }
          await docRef.set(payload, { merge: true });
          pendingRegistrationContact = null;
        }
      } catch (error) {
        console.error("同步會員資料時發生非預期錯誤:", error);
      }
    }

    async function handleLoginSubmit(event) {
      event.preventDefault();
      const email = $('#loginEmailInput').value.trim();
      const password = $('#loginPasswordInput').value;
      $('#loginErrorFront').hidden = true;
      try {
        await auth.signInWithEmailAndPassword(email, password);
        $('#loginFormFront').reset();
        showToast('登入成功');
      } catch (error) {
        $('#loginErrorFront').textContent = translateAuthError(error);
        $('#loginErrorFront').hidden = false;
      }
    }

    async function handleRegisterSubmit(event) {
      event.preventDefault();
      const displayName = $('#registerNameInput').value.trim();
      const email = $('#registerEmailInput').value.trim();
      const password = $('#registerPasswordInput').value;
      const lineId = $('#registerLineIdInput').value.trim();
      const phone = $('#registerPhoneInput').value.trim();
      $('#registerErrorFront').hidden = true;

      // 先暫存這次註冊填寫的聯絡資訊，讓 onAuthStateChanged → ensureUserDocument
      // 在建立會員文件的當下（create）就一起寫入，之後就再也改不了。
      pendingRegistrationContact = (lineId || phone) ? { lineId, phone } : null;

      try {
        const credential = await auth.createUserWithEmailAndPassword(email, password);
        await credential.user.updateProfile({ displayName });
        $('#registerFormFront').reset();
        showToast('註冊成功，已自動登入');
      } catch (error) {
        pendingRegistrationContact = null;
        $('#registerErrorFront').textContent = translateAuthError(error);
        $('#registerErrorFront').hidden = false;
      }
    }

    async function handleLogout() {
      try {
        await auth.signOut();
        showToast('已安全登出');
      } catch (error) {
        console.error('登出失敗：', error);
        showToast('登出時發生錯誤');
      }
    }

    function translateAuthError(error) {
      const map = {
        'auth/invalid-email': 'Email 格式不正確',
        'auth/user-not-found': '找不到此帳號',
        'auth/wrong-password': '密碼錯誤',
        'auth/invalid-credential': 'Email 或密碼錯誤',
        'auth/email-already-in-use': '此 Email 已被註冊過',
        'auth/weak-password': '密碼至少需要 6 位'
      };
      return map[error.code] || '發生錯誤，請再試一次';
    }

    function renderMemberView() {
      const isLoggedIn = !!memberState.user;
      $('#memberAuthArea').hidden = isLoggedIn;
      $('#memberDashboard').hidden = !isLoggedIn;
      if (isLoggedIn) {
        const email = memberState.user.email || '';
        $('#memberEmailLabel').textContent = email;
        $('#memberAvatar').textContent = email.charAt(0).toUpperCase() || '?';
        renderMemberSince();
        renderFavoritesGrid();
        updateMemberStats();
      }
    }

    function renderMemberSince() {
      const label = $('#memberSinceLabel');
      label.textContent = '載入中…';
      db.collection('users').doc(memberState.user.uid).get().then(snap => {
        const data = snap.data();
        if (data && data.updatedAt) {
          const date = data.updatedAt.toDate();
          const text = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} 更新`;
          label.textContent = text;
        } else {
          label.textContent = '';
        }
        memberState.displayName = (data && data.displayName) || '';
        renderMemberName();
      }).catch(() => { label.textContent = ''; });
    }

    function renderMemberName() {
      const name = memberState.displayName || '（未設定名稱）';
      $('#memberNameLabel').textContent = name;
    }

    function startEditMemberName() {
      $('#memberNameInput').value = memberState.displayName || '';
      $('#memberNameDisplayRow').hidden = true;
      $('#memberNameEditRow').hidden = false;
      $('#memberNameInput').focus();
    }

    function cancelEditMemberName() {
      $('#memberNameDisplayRow').hidden = false;
      $('#memberNameEditRow').hidden = true;
    }

    async function saveMemberName() {
      const newName = $('#memberNameInput').value.trim();
      if (!newName) {
        showToast('會員名稱不能留空');
        return;
      }
      const saveButton = $('#memberNameSaveButton');
      saveButton.disabled = true;

      try {
        await db.collection('users').doc(memberState.user.uid).update({
          displayName: newName,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        memberState.displayName = newName;
        renderMemberName();
        cancelEditMemberName();
        showToast('會員名稱已更新');
      } catch (error) {
        console.error('更新會員名稱失敗：', error);
        showToast('更新失敗，請再試一次');
      } finally {
        saveButton.disabled = false;
      }
    }

    function updateMemberStats() {
      $('#memberFavoriteCount').textContent = memberState.favoriteIds.size;
      $('#memberOrderCount').textContent = memberState.orderCount || 0;
    }

    function favoriteDocId(uid, productId) {
      return `${uid}_${productId}`;
    }

    function listenToFavorites(uid) {
      if (memberState.favoritesUnsub) memberState.favoritesUnsub();
      
      memberState.favoritesUnsub = db.collection('favorites')
        .where('userId', '==', uid)
        .onSnapshot(snapshot => {
          memberState.favoriteIds = new Set(snapshot.docs.map(doc => doc.data().productId));
          updateFavoriteButtonUI();
          if (!$('#pageMember').hidden) {
            renderFavoritesGrid();
            updateMemberStats();
          }
        }, error => {
          console.error('監聽收藏失敗：', error);
        });
    }

    async function toggleCurrentProductFavorite() {
      if (!requireLogin()) return;
      const product = state.currentProduct;
      if (!product) return;

      const button = $('#detailFavoriteButton');
      if (button.disabled) return;
      button.disabled = true;

      const uid = memberState.user.uid;
      const productId = String(product.id).trim();
      const docId = favoriteDocId(uid, productId);
      const isFavorited = memberState.favoriteIds.has(productId);

      try {
        if (isFavorited) {
          await db.collection('favorites').doc(docId).delete();
          memberState.favoriteIds.delete(productId);
          showToast('已從收藏移除');
        } else {
          await db.collection('favorites').doc(docId).set({
            userId: uid,
            productId: productId,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          memberState.favoriteIds.add(productId);
          showToast('已加入收藏');
        }
        updateFavoriteButtonUI();
        if (!$('#pageMember').hidden) {
          renderFavoritesGrid();
          updateMemberStats();
        }
      } catch (error) {
        console.error("收藏操作失敗：", error);
        showToast('操作失敗，請再試一次');
      } finally {
        button.disabled = false;
      }
    }

    function updateFavoriteButtonUI() {
      const button = $('#detailFavoriteButton');
      if (!button || !state.currentProduct) return;
      
      const productId = String(state.currentProduct.id).trim();
      const isFavorited = memberState.favoriteIds.has(productId);
      
      button.textContent = isFavorited ? '♥ 已收藏' : '♡ 加入收藏';
      button.classList.toggle('favorited', isFavorited);
    }

    function renderFavoritesGrid() {
      const grid = $('#favoritesGrid');
      const favoriteProducts = PRODUCTS.filter(product => memberState.favoriteIds.has(product.id));

      if (!favoriteProducts.length) {
        grid.innerHTML = `
          <div class="mc-empty">
            <i class="ti ti-heart"></i>
            <strong>還沒有收藏的商品</strong>
            <p>瀏覽商品時點選「加入收藏」，喜歡的包款都會出現在這裡。</p>
          </div>
        `;
        return;
      }

      grid.innerHTML = favoriteProducts.map(product => `
        <article class="product-card">
          <button type="button" data-id="${product.id}" aria-label="查看 ${escapeHtml(product.name)}">
            <span class="product-image"><img src="${escapeHtml(cldGrid(product.images[0]))}" alt="${escapeHtml(product.name)}" loading="lazy"></span>
            <span class="product-meta">
              <small>${escapeHtml(product.brand)}</small>
              <strong>${escapeHtml(product.name)}</strong>
              <em>${escapeHtml(product.condition)}</em>
              <b>${money(product.price)}</b>
            </span>
          </button>
        </article>
      `).join('');

      grid.querySelectorAll('.product-card button').forEach(button => {
        button.addEventListener('click', () => openProductDetail(button.dataset.id));
      });
    }

    // ── 訂單功能 ──
    let lastOrderTime = 0;
    const ORDER_COOLDOWN_MS = 30000; 

    function listenToOrders(uid) {
      if (memberState.ordersUnsub) memberState.ordersUnsub();

      memberState.ordersUnsub = db.collection('orders')
        .where('userId', '==', uid)
        .orderBy('createdAt', 'desc')
        .onSnapshot(snapshot => {
          const orders = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          }));

          memberState.orderCount = orders.length;
          
          renderOrderAlert(orders);
          renderMyOrders(orders);
          
          if (!$('#pageMember').hidden) {
            updateMemberStats();
          }
        }, error => {
          console.error('監聽訂單失敗：', error);
          $('#ordersList').innerHTML = '<p class="empty">訂單資料加載失敗，請稍後重試。</p>';
        });
    }

    async function submitOrderForCurrentProduct() {
      if (!requireLogin()) return;
      const product = state.currentProduct;
      if (!product) return;

      const button = $('#detailBuyButton');
      if (button.disabled) return; 

      const nowTime = Date.now();
      if (nowTime - lastOrderTime < ORDER_COOLDOWN_MS) {
        const remainingSeconds = Math.ceil((ORDER_COOLDOWN_MS - (nowTime - lastOrderTime)) / 1000);
        showToast(`操作太快囉！請等待 ${remainingSeconds} 秒後再試`);
        return;
      }

      button.disabled = true;
      button.textContent = '送出中…';

      const now = new Date();
      const dateStr = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
      const randomStr = Math.random().toString(36).substring(2, 6).toUpperCase();
      const generatedOrderNo = `OD${dateStr}${randomStr}`;

      const itemPrice = Number(product.price || 0);
      const itemQuantity = 1; 
      const totalAmount = itemPrice * itemQuantity;
      const uid = memberState.user.uid;

      try {
        await db.collection('orders').add({
          productId: String(product.id).trim(), 
          productName: product.name,
          productBrand: product.brand,
          imageUrl: product.images[0] || '',
          customerName: memberState.user.email,
          contact: '',
          userId: uid,       
          userEmail: memberState.user.email,
          status: 'pending',                 
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          source: 'online',
          price: itemPrice,                  
          quantity: itemQuantity,            
          totalAmount: totalAmount,          
          productNo: product.productNo || product.id,
          orderNo: generatedOrderNo
        });

        lastOrderTime = Date.now();
        showToast('已送出購買需求！正在為您開啟 LINE 詢問...');
        
        startOrderButtonCooldown(button);

        setTimeout(() => {
          const productText = `您好！我已在官網送出購買訂單（編號：${generatedOrderNo}），我想購買「${product.name}」！`;
          const url = `https://line.me/R/ti/p/${encodeURIComponent(LINE_ID)}?text=${encodeURIComponent(productText)}`;
          window.open(url, '_blank', 'noopener');
        }, 1200);

      } catch (error) {
        console.error("Firestore 寫入訂單失敗：", error);
        showToast('送出失敗，請確認商品資訊或聯絡客服');
        button.disabled = false;
        button.textContent = '我要購買';
      }
    }

    function startOrderButtonCooldown(button) {
      let timeLeft = ORDER_COOLDOWN_MS / 1000;
      button.disabled = true;
      button.style.cursor = 'not-allowed';
      button.style.opacity = '0.6';
      button.textContent = `我要購買 (${timeLeft}s)`;

      const cooldownTimer = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) {
          clearInterval(cooldownTimer);
          button.disabled = false;
          button.style.cursor = 'pointer';
          button.style.opacity = '1';
          button.textContent = '我要購買';
        } else {
          button.textContent = `我要購買 (${timeLeft}s)`;
        }
      }, 1000);
    }

    function renderOrderAlert(orders) {
      const alertButton = $('#memberOrderAlert');
      const activeOrders = orders.filter(order => order.status !== 'completed' && order.status !== 'cancelled');

      if (!activeOrders.length) {
        alertButton.hidden = true;
        return;
      }

      const latest = activeOrders[0];
      const extraCount = activeOrders.length - 1;

      $('#memberOrderAlertTitle').textContent = latest.productName || '商品訂單';
      
      $('#memberOrderAlertSub').textContent = extraCount > 0
        ? `${latest.productBrand || ''}・還有 ${extraCount} 筆訂單進行中`
        : `${latest.productBrand || ''}・訂單進行中`;

      const statusEl = $('#memberOrderAlertStatus');
      statusEl.textContent = ORDER_STATUS_LABELS[latest.status] || latest.status;
      statusEl.className = 'mc-pill status-' + latest.status;

      alertButton.hidden = false;
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

    const ORDER_STATUS_LABELS = {
      pending: '處理中',
      waiting: '處理中',   
      confirmed: '已確認',
      unpaid: '未付款',
      preparing: '待出貨',
      shipping: '寄送中',
      arrived: '已到指定地點',
      completed: '已完成',
      cancelled: '已取消'
    };

    function renderMyOrders(orders) {
      const list = $('#ordersList');
      if (!orders.length) {
        list.innerHTML = `
          <div class="mc-empty">
            <i class="ti ti-shopping-bag"></i>
            <strong>還沒有訂單記錄</strong>
            <p>看到喜歡的商品，點選「我要購買」就會出現在這裡。</p>
          </div>
        `;
        return;
      }
      list.innerHTML = orders.map(order => {
        const dateText = order.createdAt
          ? formatOrderTime(order.createdAt)
          : '';
        return `
        <article class="member-order-card status-${order.status}">
          <span class="mc-ribbon">${ORDER_STATUS_LABELS[order.status] || order.status}</span>
          ${order.imageUrl ? `<img src="${escapeHtml(cldThumb(order.imageUrl))}" alt="${escapeHtml(order.productName || '')}">` : ''}
          <div class="member-order-info">
            <small>${escapeHtml(order.productBrand || '')}</small>
            <strong>${escapeHtml(order.productName || '')}</strong>
            <div class="mc-order-footer">
              <span>${money(order.price)}</span>
              <em class="mc-order-date">${dateText}</em>
            </div>
          </div>
        </article>
      `;
      }).join('');
    }

    function requireLogin() {
      if (memberState.user) return true;
      showToast('請先登入會員');
      showPage('member');
      return false;
    }

    function openLine() {
      const productText = state.currentProduct ? `您好，我想詢問「${state.currentProduct.name}」` : '您好，我想詢問 YA3S 商品';
      const url = `https://line.me/R/ti/p/${encodeURIComponent(LINE_ID)}?text=${encodeURIComponent(productText)}`;
      window.open(url, '_blank', 'noopener');
    }

    function copyProductLink() {
      const text = state.currentProduct ? `${location.origin}${location.pathname}?p=${state.currentProduct.id}` : location.href;
      
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(() => showToast('已複製商品連結'))
          .catch(() => fallbackCopyText(text));
      } else {
        fallbackCopyText(text);
      }
    }

    function fallbackCopyText(text) {
      try {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";  
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (successful) {
          showToast('已複製商品連結');
        } else {
          showToast('複製失敗，請手動複製網址');
        }
      } catch (err) {
        showToast('瀏覽器不支援自動複製');
      }
    }

    function openLightbox() {
      if (!state.currentImage) return;
      $('#lightbox').hidden = false;
      document.body.classList.add('no-scroll');
    }

    function closeLightbox() {
      $('#lightbox').hidden = true;
      document.body.classList.remove('no-scroll');
    }

    function toggleMenu() {
      const open = $('#mobileNav').classList.toggle('open');
      $('#menuButton').classList.toggle('open', open);
      $('#menuButton').setAttribute('aria-expanded', String(open));
    }

    function closeMenu() {
      $('#mobileNav').classList.remove('open');
      $('#menuButton').classList.remove('open');
      $('#menuButton').setAttribute('aria-expanded', 'false');
    }

    function showToast(message) {
      const toast = $('#toast');
      toast.textContent = message;
      toast.classList.add('show');
      window.clearTimeout(showToast.timer);
      showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2200);
    }

    function openFromQuery() {
      const id = new URLSearchParams(location.search).get('p');
      if (id && PRODUCTS.some(product => product.id === id) && $('#pageDetail').hidden) {
        openProductDetail(id);
      }
    }

    document.addEventListener('DOMContentLoaded', init);