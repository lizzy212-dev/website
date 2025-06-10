const express = require('express');
const path = require('path');
const { URLSearchParams } = require('url');
const mongoose = require('mongoose');

const app = express();
const port = process.env.PORT || 3000;

const ATLANTIC_BASE_URL = 'https://atlantich2h.com';
const API_KEY = '#';
const MONGODB_URI = '#';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let productsCache = [];
let paymentMethodsCache = [];

const orderSchema = new mongoose.Schema({
    orderId: { type: String, required: true, unique: true, index: true },
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    productPrice: { type: Number, required: true },
    providerName: { type: String, required: true },
    productImgUrl: { type: String },
    targetId: { type: String, required: true },
    paymentMethodCode: { type: String, required: true },
    paymentMethodName: { type: String, required: true },
    adminFeePaymentMethod: { type: Number, default: 0 },
    adminFeeGlobal: { type: Number, default: 0 },
    totalAdminFee: { type: Number, default: 0 },
    totalAmountToPayForDeposit: { type: Number, required: true },
    status: { type: String, required: true, default: 'PENDING_PAYMENT' },
    atlanticDepositId: { type: String },
    depositReffId: { type: String },
    depositDetails: { type: Object },
    atlanticTransactionId: { type: String },
    transactionReffId: { type: String },
    transactionDetails: { type: Object },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

mongoose.connect(MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => {
    console.error('Connection error', err);
    process.exit(1);
  });


const Order = mongoose.model('Order', orderSchema);


async function fetchAtlanticAPI(endpoint, bodyParams = {}, method = 'POST') {
    const params = new URLSearchParams();
    params.append('api_key', API_KEY);
    for (const key in bodyParams) {
        params.append(key, bodyParams[key]);
    }

    const urlnya = `${ATLANTIC_BASE_URL}${endpoint}`;
    
    const options = {
        method,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'MyCustomUserAgent/1.0 (compatible; RerezzBot/2025)',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': urlnya,
        }
    };

    if (method === 'POST' || method === 'PUT') {
        options.body = params.toString();
    }

    try {
        const response = await fetch(urlnya, options);

        if (!response.ok) {
            const errorText = await response.text();
            try {
                const errorJson = JSON.parse(errorText);
                throw new Error(errorJson.message || `API request failed with status ${response.status}`);
            } catch {
                throw new Error(`API request failed with status ${response.status}: ${errorText}`);
            }
        }
        return await response.json();
    } catch (error) {
        throw error;
    }
}


async function initializeData() {
    try {
        const productData = await fetchAtlanticAPI('/layanan/price_list', { type: 'prabayar' });
        if (productData && productData.status && productData.data) {
            productsCache = productData.data.filter(p => p.status === 'available');
        }

        const paymentMethodData = await fetchAtlanticAPI('/deposit/metode', {});
        if (paymentMethodData && paymentMethodData.status && paymentMethodData.data) {
            paymentMethodsCache = paymentMethodData.data.filter(pm => pm.status === 'aktif');
        }
    } catch (error) {
        console.error('Initialization error:', error.message);
    }
}

app.get('/api/providers', (req, res) => {
    if (productsCache.length === 0) {
        return res.status(503).json({ status: false, message: 'Layanan produk belum siap, coba beberapa saat lagi.' });
    }
    const providersMap = new Map();
    productsCache.forEach(p => {
        if (!providersMap.has(p.provider)) {
            providersMap.set(p.provider, {
                name: p.provider,
                category: p.category,
                img_url: p.img_url
            });
        }
    });
    const uniqueProviders = Array.from(providersMap.values());
    res.json({ status: true, data: uniqueProviders });
});

app.get('/api/products/:providerName', (req, res) => {
    if (productsCache.length === 0) {
        return res.status(503).json({ status: false, message: 'Layanan produk belum siap, coba beberapa saat lagi.' });
    }
    const providerName = decodeURIComponent(req.params.providerName);
    const filteredProducts = productsCache.filter(p => p.provider.toLowerCase() === providerName.toLowerCase());
    
    if (filteredProducts.length === 0) {
         return res.status(404).json({ status: false, message: `Produk untuk ${providerName} tidak ditemukan.` });
    }
    res.json({ status: true, data: filteredProducts, provider: providerName });
});

app.get('/api/payment-methods', (req, res) => {
    if (paymentMethodsCache.length === 0) {
        return res.status(503).json({ status: false, message: 'Metode pembayaran belum siap, coba beberapa saat lagi.' });
    }
    const ADDITIONAL_ADMIN_FEE_PERCENT = 2;

    const processedPaymentMethods = paymentMethodsCache.map(method => {
        return {
            ...method,
            additional_admin_fee_percent: ADDITIONAL_ADMIN_FEE_PERCENT 
        };
    });
    
    const filtered = processedPaymentMethods.filter(item => {
        const blocked = ['OVO', 'QRIS', 'DANA', 'ovo', 'MANDIRI', 'PERMATA'];
        return !blocked.includes(item.metode);
    });

    res.json({ status: true, data: filtered });
});

app.post('/api/create-order', async (req, res) => {
    const { productId, targetId, paymentMethodCode, providerName } = req.body;

    if (!productId || !targetId || !paymentMethodCode || !providerName) {
        return res.status(400).json({ status: false, message: 'Data tidak lengkap.' });
    }

    const selectedProduct = productsCache.find(p => p.code === productId && (p.provider.toLowerCase() === providerName.toLowerCase() || p.category.toLowerCase() === providerName.toLowerCase()));
    if (!selectedProduct) {
        return res.status(404).json({ status: false, message: 'Produk tidak ditemukan.' });
    }

    const selectedPaymentMethod = paymentMethodsCache.find(pm => pm.metode === paymentMethodCode);
    if (!selectedPaymentMethod) {
        return res.status(404).json({ status: false, message: 'Metode pembayaran tidak ditemukan.' });
    }

    const orderIdInternal = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    const depositReffId = `DEP-${orderIdInternal}`;
    
    const baseProductPrice = parseFloat(selectedProduct.price);
    const paymentMethodFee = parseFloat(selectedPaymentMethod.fee) || 0;
    const paymentMethodFeePercent = parseFloat(selectedPaymentMethod.fee_persen) || 0;
    const additionalAdminFeePercentGlobal = 2;

    const feeFromPaymentMethod = paymentMethodFee + (baseProductPrice * (paymentMethodFeePercent / 100));
    const globalAdminFee = baseProductPrice * (additionalAdminFeePercentGlobal / 100);
    const totalAdminFee = feeFromPaymentMethod + globalAdminFee;
    const totalAmountForDeposit = baseProductPrice + totalAdminFee;

    try {
        const depositPayload = {
            reff_id: depositReffId,
            nominal: Math.ceil(totalAmountForDeposit), 
            type: selectedPaymentMethod.type,
            metode: selectedPaymentMethod.metode
        };
        
        const depositResponse = await fetchAtlanticAPI('/deposit/create', depositPayload);

        if (!depositResponse.status || !depositResponse.data) {
            return res.status(500).json({ status: false, message: depositResponse.message || 'Gagal membuat deposit.' });
        }

        const newOrder = new Order({
            orderId: orderIdInternal,
            productId,
            productName: selectedProduct.name,
            productPrice: baseProductPrice,
            providerName: selectedProduct.provider,
            productImgUrl: selectedProduct.img_url,
            targetId,
            paymentMethodCode,
            paymentMethodName: selectedPaymentMethod.name,
            adminFeePaymentMethod: feeFromPaymentMethod,
            adminFeeGlobal: globalAdminFee,
            totalAdminFee: totalAdminFee,
            totalAmountToPayForDeposit: Math.ceil(totalAmountForDeposit),
            atlanticDepositId: depositResponse.data.id,
            depositReffId: depositReffId,
            depositDetails: depositResponse.data,
            status: 'PENDING_PAYMENT',
            updatedAt: new Date()
        });
        
        await newOrder.save();

        res.json({
            status: true,
            orderId: orderIdInternal,
            paymentDetails: depositResponse.data,
            productName: selectedProduct.name,
            targetId: targetId,
            basePrice: baseProductPrice,
            totalAdminFee: totalAdminFee,
            totalAmount: Math.ceil(totalAmountForDeposit)
        });

    } catch (error) {
        console.error("Create order error:", error);
        res.status(500).json({ status: false, message: `Gagal memproses pesanan: ${error.message}` });
    }
});

app.get('/api/order-status/:orderId', async (req, res) => {
    const { orderId } = req.params;
    
    if (!orderId) {
        return res.status(400).json({ status: false, message: 'Order ID diperlukan.' });
    }

    try {
        let order = await Order.findOne({ orderId: orderId });

        if (!order) {
            return res.status(404).json({ status: false, message: 'Pesanan tidak ditemukan.' });
        }

        if (order.status === 'PENDING_PAYMENT' || order.status === 'PAYMENT_PROCESSING') {
            const depositStatusResponse = await fetchAtlanticAPI('/deposit/status', { id: order.atlanticDepositId });
            
            if (depositStatusResponse.status && depositStatusResponse.data) {
                const atlanticStatus = depositStatusResponse.data.status.toUpperCase();
                order.updatedAt = new Date();
                order.depositDetails = {...order.depositDetails, ...depositStatusResponse.data};

                if (atlanticStatus === 'SUCCESS') {
                    order.status = 'PAYMENT_SUCCESSFUL_PROCESSING_ORDER';
                    const transactionReffId = `TRX-${order.orderId}`;
                    order.transactionReffId = transactionReffId;
                    
                    try {
                         const createTransactionResponse = await fetchAtlanticAPI('/transaksi/create', {
                            code: order.productId,
                            reff_id: transactionReffId,
                            target: order.targetId
                        });

                        if (createTransactionResponse.status && createTransactionResponse.data) {
                            order.atlanticTransactionId = createTransactionResponse.data.id;
                            order.transactionDetails = createTransactionResponse.data;
                            order.status = createTransactionResponse.data.status ? createTransactionResponse.data.status.toUpperCase() : 'ORDER_PROCESSING';
                             if (order.status === 'PENDING') order.status = 'ORDER_PROCESSING';
                        } else {
                            order.status = 'TRANSACTION_CREATION_FAILED';
                            order.transactionDetails = { error: createTransactionResponse.message || 'Gagal membuat transaksi' };
                        }
                    } catch (txError) {
                        order.status = 'TRANSACTION_CREATION_ERROR';
                        order.transactionDetails = { error: `Internal error: ${txError.message}` };
                    }

                } else if (['EXPIRED', 'FAILED', 'CANCEL'].includes(atlanticStatus)) {
                    order.status = `PAYMENT_${atlanticStatus}`;
                } else if (atlanticStatus === 'PENDING') {
                    order.status = 'PENDING_PAYMENT';
                } else {
                    order.status = 'PAYMENT_PROCESSING'; 
                }
                await order.save();
            }
        } else if (order.status === 'ORDER_PROCESSING' || order.status === 'PAYMENT_SUCCESSFUL_PROCESSING_ORDER' || order.status === 'TRANSACTION_CREATION_FAILED') {
            if (order.atlanticTransactionId) {
                const transactionStatusResponse = await fetchAtlanticAPI('/transaksi/status', {
                    id: order.atlanticTransactionId,
                    type: 'prabayar' 
                });
                order.updatedAt = new Date();

                if (transactionStatusResponse.status && transactionStatusResponse.data) {
                    const atlanticTxStatus = transactionStatusResponse.data.status.toUpperCase();
                    order.transactionDetails = {...order.transactionDetails, ...transactionStatusResponse.data};

                    if (atlanticTxStatus === 'SUCCESS') {
                        order.status = 'ORDER_COMPLETED';
                    } else if (['FAILED', 'ERROR'].includes(atlanticTxStatus)) {
                        order.status = 'ORDER_FAILED';
                    } else if (atlanticTxStatus === 'PENDING') {
                        order.status = 'ORDER_PROCESSING';
                    } else {
                        order.status = atlanticTxStatus;
                    }
                }
                await order.save();

            } else if (order.status === 'PAYMENT_SUCCESSFUL_PROCESSING_ORDER' && !order.atlanticTransactionId) {
                const transactionReffId = `TRX-${order.orderId}`;
                order.updatedAt = new Date();
                order.transactionReffId = transactionReffId;
                try {
                     const createTransactionResponse = await fetchAtlanticAPI('/transaksi/create', {
                        code: order.productId,
                        reff_id: transactionReffId,
                        target: order.targetId
                    });
                    if (createTransactionResponse.status && createTransactionResponse.data) {
                        order.atlanticTransactionId = createTransactionResponse.data.id;
                        order.transactionDetails = createTransactionResponse.data;
                        order.status = createTransactionResponse.data.status ? createTransactionResponse.data.status.toUpperCase() : 'ORDER_PROCESSING';
                        if (order.status === 'PENDING') order.status = 'ORDER_PROCESSING';
                    } else {
                        order.status = 'TRANSACTION_CREATION_FAILED';
                        order.transactionDetails = { error: createTransactionResponse.message || 'Gagal membuat transaksi (ulang)' };
                    }
                } catch (txError) {
                    order.status = 'TRANSACTION_CREATION_ERROR';
                    order.transactionDetails = { error: `Internal error (ulang): ${txError.message}` };
                }
                await order.save();
            }
        }
        
        res.json({ status: true, data: order });

    } catch (error) {
        console.error("Order status error:", error);
        res.status(500).json({ status: false, message: `Internal server error: ${error.message}` });
    }
});

app.post('/api/cancel-order/:orderId', async (req, res) => {
    const { orderId } = req.params;
    if (!orderId) {
        return res.status(400).json({ status: false, message: 'Order ID diperlukan.' });
    }
    try {
        const order = await Order.findOne({ orderId: orderId });

        if (!order) {
            return res.status(404).json({ status: false, message: 'Pesanan tidak ditemukan.' });
        }

        if (!order.atlanticDepositId) {
            return res.status(400).json({ status: false, message: 'Deposit ID tidak ditemukan.' });
        }

        if (order.status !== 'PENDING_PAYMENT' && order.status !== 'PAYMENT_PROCESSING') {
            return res.status(400).json({ status: false, message: `Pesanan status ${order.status} tidak bisa dibatalkan.` });
        }

        const cancelResponse = await fetchAtlanticAPI('/deposit/cancel', { id: order.atlanticDepositId });

        if (cancelResponse.status && cancelResponse.data && cancelResponse.data.status && cancelResponse.data.status.toLowerCase() === 'cancel') {
            order.status = 'PAYMENT_CANCELLED';
            order.updatedAt = new Date();
            if (order.depositDetails) {
                order.depositDetails.status = 'cancel';
            } else {
                order.depositDetails = { status: 'cancel' };
            }
            await order.save();
            res.json({ status: true, message: 'Pesanan berhasil dibatalkan.', data: order });
        } else {
            res.status(500).json({ status: false, message: cancelResponse.message || 'Gagal membatalkan deposit di AtlanticH2H.' });
        }
    } catch (error) {
        console.error("Cancel order error:", error);
        res.status(500).json({ status: false, message: `Gagal membatalkan pesanan: ${error.message}` });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function startServer() {
    await initializeData();
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}

startServer().catch(err => {
    console.error("Failed to start server.", err);
    process.exit(1);
});
