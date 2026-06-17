// API base URL
const API_BASE = 'http://localhost:5000/api';

function getAuthHeader() {
    return { 'Authorization': 'Basic YWRtaW46YWRtaW4xMjM=' };
}

// IndexedDB setup
const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('FraudShieldDB', 1);
    request.onerror = event => reject(event.target.error);
    request.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('transactions')) db.createObjectStore('transactions', { keyPath: 'transaction_id' });
        if (!db.objectStoreNames.contains('alerts')) db.createObjectStore('alerts', { keyPath: 'alert_id' });
        if (!db.objectStoreNames.contains('syncQueue')) db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
    };
    request.onsuccess = event => resolve(event.target.result);
});

async function saveToDB(storeName, data) {
    const db = await dbPromise;
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    if (Array.isArray(data)) {
        store.clear();
        data.forEach(item => store.put(item));
    } else {
        store.put(data);
    }
    return new Promise(resolve => tx.oncomplete = resolve);
}

async function getFromDB(storeName) {
    const db = await dbPromise;
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    return new Promise(resolve => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
    });
}

async function clearStore(storeName) {
    const db = await dbPromise;
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    return new Promise(resolve => tx.oncomplete = resolve);
}

// Initialize dashboard
document.addEventListener('DOMContentLoaded', function() {
    loadDashboardData();
    setupEventListeners();
    
    // Refresh every 30 seconds if online
    setInterval(() => {
        if (navigator.onLine) loadDashboardData();
    }, 30000);
});

function setupEventListeners() {
    window.addEventListener('online', () => {
        const indicator = document.getElementById('offlineIndicator');
        if (indicator) indicator.style.display = 'none';
        
        const onlineIndicator = document.getElementById('onlineIndicator');
        if (onlineIndicator) {
            onlineIndicator.style.display = 'block';
            setTimeout(() => {
                onlineIndicator.style.display = 'none';
            }, 3000);
        }
        
        syncOfflineData();
        loadDashboardData();
    });
    
    window.addEventListener('offline', () => {
        const indicator = document.getElementById('offlineIndicator');
        if (indicator) indicator.style.display = 'block';
    });
    
    if (!navigator.onLine) {
        const indicator = document.getElementById('offlineIndicator');
        if (indicator) indicator.style.display = 'block';
    }

    const form = document.getElementById('transactionForm');
    if (form) {
        form.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const transaction = {
                transaction_id: Date.now(),
                user_id: parseInt(document.getElementById('userId').value),
                amount: parseFloat(document.getElementById('amount').value),
                payment_method: document.getElementById('paymentMethod').value,
                location: document.getElementById('location').value,
                timestamp: new Date().toISOString()
            };
            
            const processOffline = async () => {
                // Offline fallback heuristic
                const isFraud = transaction.amount > 1000;
                const result = {
                    is_fraud: isFraud,
                    fraud_probability: isFraud ? 0.95 : 0.05,
                    combined_score: isFraud ? 0.95 : 0.05,
                    anomaly_score: 0,
                    transaction_id: transaction.transaction_id,
                    message: isFraud ? 'Transaction flagged as suspicious (Offline Mode)' : 'Transaction appears legitimate (Offline Mode)'
                };
                
                // Add to sync queue
                await saveToDB('syncQueue', { type: 'transaction', data: transaction });
                showResult(result);
                
                // Save locally to display
                const localTx = { ...transaction, fraud_probability: result.fraud_probability, is_fraud: result.is_fraud };
                
                const db = await dbPromise;
                const txTrans = db.transaction('transactions', 'readwrite');
                txTrans.objectStore('transactions').put(localTx);
                
                if (isFraud) {
                    const txAlerts = db.transaction('alerts', 'readwrite');
                    txAlerts.objectStore('alerts').put({
                        alert_id: Date.now(),
                        transaction_id: transaction.transaction_id,
                        user_id: transaction.user_id,
                        amount: transaction.amount,
                        timestamp: transaction.timestamp,
                        risk_score: result.combined_score,
                        status: 'pending'
                    });
                }
                loadDashboardData();
            };

            if (!navigator.onLine) {
                await processOffline();
                return;
            }

            try {
                const response = await fetch(`${API_BASE}/transaction`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...getAuthHeader()
                    },
                    body: JSON.stringify(transaction)
                });
                
                if (!response.ok) throw new Error('Network response was not ok');
                
                const result = await response.json();
                showResult(result);
                loadDashboardData(); // Refresh data
                
            } catch (error) {
                console.error('Network Error, falling back to offline mode:', error);
                await processOffline();
            }
        });
    }
}

async function syncOfflineData() {
    const queue = await getFromDB('syncQueue');
    if (queue.length === 0) return;
    
    for (const item of queue) {
        try {
            if (item.type === 'transaction') {
                await fetch(`${API_BASE}/transaction`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...getAuthHeader()
                    },
                    body: JSON.stringify(item.data)
                });
            } else if (item.type === 'resolve') {
                await fetch(`${API_BASE}/alerts/${item.alertId}/resolve`, {
                    method: 'POST',
                    headers: { 'Authorization': 'Basic YWRtaW46YWRtaW4xMjM=' }
                });
            }
        } catch (e) {
            console.error('Sync failed, will retry later:', e);
            return; 
        }
    }
    
    await clearStore('syncQueue');
    console.log("Offline data synced successfully.");
}

function showResult(result) {
    const alertDiv = document.getElementById('resultAlert');
    if (!alertDiv) return;
    alertDiv.style.display = 'block';
    
    if (result.is_fraud) {
        alertDiv.className = 'alert alert-danger';
        alertDiv.innerHTML = `
            <strong>⚠️ FRAUD ALERT!</strong><br>
            ${result.message || 'Transaction flagged as suspicious.'}<br>
            Risk Score: ${(result.combined_score * 100).toFixed(1)}%<br>
            Fraud Probability: ${(result.fraud_probability * 100).toFixed(1)}%<br>
            <span class="badge bg-danger mt-2">📱 SMS Alert Dispatched</span>
        `;
    } else {
        alertDiv.className = 'alert alert-success';
        alertDiv.innerHTML = `
            <strong>✅ Transaction Legitimate</strong><br>
            Risk Score: ${(result.combined_score * 100).toFixed(1)}%
        `;
    }
    
    // Hide after 5 seconds
    setTimeout(() => {
        alertDiv.style.display = 'none';
    }, 5000);
}

async function loadDashboardData() {
    await loadTransactions();
    await loadAlerts();
    updateStats();
    updateChart();
}

function renderTransactions(transactions) {
    const tbody = document.getElementById('transactionsBody');
    if (!tbody) return;
    if (transactions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center">No transactions yet</td></tr>';
        document.getElementById('totalTransactions').textContent = '0';
        return;
    }
    
    // Sort reverse chronological
    const sorted = [...transactions].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    tbody.innerHTML = sorted.map(tx => `
        <tr class="${tx.is_fraud ? 'table-danger' : ''}">
            <td>${tx.transaction_id}</td>
            <td>${tx.user_id}</td>
            <td>GHS ${tx.amount.toFixed(2)}</td>
            <td>${new Date(tx.timestamp).toLocaleTimeString()}</td>
            <td>${(tx.fraud_probability * 100).toFixed(1)}%</td>
            <td>
                <span class="badge ${tx.is_fraud ? 'bg-danger' : 'bg-success'}">
                    ${tx.is_fraud ? 'FRAUD' : 'OK'}
                </span>
            </td>
        </tr>
    `).join('');
    
    // Update total count
    document.getElementById('totalTransactions').textContent = transactions.length;
}

async function loadTransactions() {
    if (!navigator.onLine) {
        const transactions = await getFromDB('transactions');
        renderTransactions(transactions);
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/transactions?limit=50`, {
            headers: getAuthHeader()
        });
        const transactions = await response.json();
        await saveToDB('transactions', transactions);
        renderTransactions(transactions);
    } catch (error) {
        console.error('Error loading transactions, falling back to local DB:', error);
        const transactions = await getFromDB('transactions');
        renderTransactions(transactions);
    }
}

function renderAlerts(alerts) {
    const alertsList = document.getElementById('alertsList');
    if (!alertsList) return;
    if (alerts.length === 0) {
        alertsList.innerHTML = '<p class="text-muted">No active alerts</p>';
        document.getElementById('activeAlerts').textContent = '0';
        return;
    }
    
    const sorted = [...alerts].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    alertsList.innerHTML = sorted.map(alert => `
        <div class="alert alert-danger alert-item">
            <strong>🚨 Fraud Alert #${alert.alert_id}</strong><br>
            User: ${alert.user_id} | Amount: GHS ${alert.amount}<br>
            Risk: ${(alert.risk_score * 100).toFixed(1)}%<br>
            <small>${new Date(alert.timestamp).toLocaleString()}</small>
            <button type="button" class="btn btn-sm btn-outline-success mt-2" 
                    onclick="window.resolveAlert(${alert.alert_id})">
                Resolve
            </button>
        </div>
    `).join('');
    
    document.getElementById('activeAlerts').textContent = alerts.length;
}

async function loadAlerts() {
    if (!navigator.onLine) {
        const alerts = await getFromDB('alerts');
        renderAlerts(alerts);
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/alerts?status=pending`, {
            headers: getAuthHeader()
        });
        const alerts = await response.json();
        await saveToDB('alerts', alerts);
        renderAlerts(alerts);
    } catch (error) {
        console.error('Error loading alerts, falling back to local DB:', error);
        const alerts = await getFromDB('alerts');
        renderAlerts(alerts);
    }
}

window.resolveAlert = async function(alertId) {
    if (!navigator.onLine) {
        await saveToDB('syncQueue', { type: 'resolve', alertId: alertId });
        
        // Remove from local IndexedDB so it instantly disappears from UI
        const db = await dbPromise;
        const tx = db.transaction('alerts', 'readwrite');
        tx.objectStore('alerts').delete(alertId);
        
        await loadAlerts();
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/alerts/${alertId}/resolve`, {
            method: 'POST',
            headers: getAuthHeader()
        });
        if (response.ok) {
            loadAlerts(); // Refresh alerts
        }
    } catch (error) {
        console.error('Error resolving alert:', error);
        // Fallback queue if connection dropped right after the check
        await saveToDB('syncQueue', { type: 'resolve', alertId: alertId });
        const db = await dbPromise;
        const tx = db.transaction('alerts', 'readwrite');
        tx.objectStore('alerts').delete(alertId);
        await loadAlerts();
    }
};

function updateStats() {
    // Calculate fraud count from displayed transactions
    const rows = document.querySelectorAll('#transactionsBody tr');
    if (!rows.length) return;
    
    let fraudCount = 0;
    rows.forEach(row => {
        if (row.classList.contains('table-danger')) fraudCount++;
    });
    
    const fraudCountEl = document.getElementById('fraudCount');
    if (fraudCountEl) fraudCountEl.textContent = fraudCount;
    
    const totalEl = document.getElementById('totalTransactions');
    const total = totalEl ? parseInt(totalEl.textContent) || 1 : 1;
    const rate = (fraudCount / total * 100).toFixed(1);
    
    const detRateEl = document.getElementById('detectionRate');
    if (detRateEl) detRateEl.textContent = rate + '%';
}

function updateChart() {
    const canvas = document.getElementById('fraudChart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    
    // Destroy existing chart if it exists
    if (window.fraudChart) {
        window.fraudChart.destroy();
    }
    
    // Sample data - in production, get from API
    window.fraudChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['1h', '2h', '3h', '4h', '5h', '6h'],
            datasets: [{
                label: 'Fraud Probability',
                data: [65, 59, 80, 81, 56, 55],
                borderColor: 'rgb(255, 99, 132)',
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100
                }
            }
        }
    });
}
