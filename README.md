# 🐸 Meme Revenue DApp — OP_NET (Bitcoin L1)

Tạo meme token trên Bitcoin Layer 1 với cơ chế chia sẻ lợi nhuận cho 100 slot holders.

---

## 📐 Kiến trúc

```
┌─────────────────────────────────────────────────────────┐
│                     MemeFactory                         │
│  - Bất kỳ ai cũng có thể tạo meme                      │
│  - Lưu registry các meme đã tạo                         │
└────────────────────┬────────────────────────────────────┘
                     │ tạo
         ┌───────────┴───────────┐
         ▼                       ▼
┌────────────────┐     ┌──────────────────────┐
│   MemeToken    │     │   RevenueSharing      │
│  (OP_20)       │────▶│  (100 Slots)          │
│                │fee  │                       │
│  - 1% fee mỗi │     │  - Đấu giá 144 blocks │
│    giao dịch  │     │  - Chia đều 100 slots  │
│  - Transfer   │     │  - Claim bất cứ lúc   │
└────────────────┘     └──────────────────────┘
```

---

## 🔄 Luồng hoạt động

### Giai đoạn 1 — Auction (144 blocks ≈ 1 ngày)

1. Meme token được tạo
2. 100 slots mở đấu giá đồng thời
3. Bất kỳ ai có thể `bidSlot(slotId, amount)` để đặt giá
4. Bid mới phải cao hơn bid cũ ít nhất **5%**
5. Sau 144 blocks, auction kết thúc

### Giai đoạn 2 — Claim Slots

6. Người thắng mỗi slot gọi `claimSlot(slotId)` để lấy slot
7. Slot owner bắt đầu nhận revenue từ thời điểm này

### Giai đoạn 3 — Revenue Sharing (liên tục)

8. Mỗi khi ai đó transfer token → **1% fee** tự động chảy vào `RevenueSharing`
9. Fee chia đều cho **100 slots** (mỗi slot nhận 1%)
10. Slot owner gọi `claimRevenue()` để rút tiền bất cứ lúc nào
11. Có thể sở hữu nhiều slot → nhận nhiều hơn

---

## 📁 Cấu trúc project

```
opnet-meme-dapp/
├── assembly/
│   └── contracts/
│       ├── MemeToken.ts        ← OP_20 token với 1% fee
│       ├── RevenueSharing.ts   ← 100 slots + auction + revenue
│       └── MemeFactory.ts      ← Factory tạo meme
├── scripts/
│   └── deploy.ts               ← Deploy script
├── tests/
│   └── (unit tests)
├── asconfig.json
└── package.json
```

---

## ⚙️ Cài đặt & Build

```bash
# 1. Clone và cài dependencies
git clone <repo>
cd opnet-meme-dapp
npm install

# 2. Build contracts
npm run build:meme      # → build/MemeToken.wasm
npm run build:revenue   # → build/RevenueSharing.wasm
npm run build:factory   # → build/MemeFactory.wasm

# 3. Deploy lên testnet
export PRIVATE_KEY=your_private_key_here
npx ts-node scripts/deploy.ts
```

---

## 📡 Contract API

### MemeToken

| Method | Mô tả |
|--------|-------|
| `transfer(to, amount)` | Transfer với 1% fee tự động |
| `transferFrom(from, to, amount)` | TransferFrom với 1% fee |
| `getFeeRate()` | Xem fee rate hiện tại (basis points) |
| `getTotalFeesCollected()` | Tổng fee đã thu |

### RevenueSharing

| Method | Mô tả |
|--------|-------|
| `bidSlot(slotId, amount)` | Đặt bid cho slot (trong auction) |
| `finalizeAuction()` | Kết thúc auction sau 144 blocks |
| `claimSlot(slotId)` | Người thắng lấy slot |
| `claimRevenue()` | Rút lợi nhuận pending |
| `getPendingRevenue(address)` | Xem revenue chưa claim |
| `getSlotInfo(slotId)` | Thông tin chi tiết một slot |
| `getAuctionInfo()` | Trạng thái auction |
| `getSlotsByOwner(address)` | Các slot của một địa chỉ |

### MemeFactory

| Method | Mô tả |
|--------|-------|
| `createMeme(tokenAddr, revAddr, name, symbol)` | Đăng ký meme mới |
| `getMemeCount()` | Tổng số meme đã tạo |
| `getMemeAt(index)` | Lấy địa chỉ meme theo index |

---

## 💡 Ví dụ sử dụng (TypeScript client)

```typescript
import { getContract, JSONRpcProvider, Wallet } from 'opnet';

const provider = new JSONRpcProvider('https://testnet.opnet.org', Network.TESTNET);
const wallet = Wallet.fromPrivateKey(privateKey, Network.TESTNET);

// Đặt bid cho slot 0 với 1000 satoshis
const revContract = getContract(REVENUE_ADDRESS, REVENUE_ABI, provider, wallet);
await revContract.bidSlot(0, 1000n).sendTransaction(txParams);

// Xem pending revenue
const pending = await revContract.getPendingRevenue(myAddress);
console.log('Pending:', pending.properties.amount);

// Claim revenue
await revContract.claimRevenue().sendTransaction(txParams);
```

---

## 🔐 Bảo mật

- Chỉ `MemeToken` mới có thể gửi fee vào `RevenueSharing`
- Chỉ người thắng đấu giá mới có thể claim slot
- Revenue tracking dùng **checkpoint pattern** để tránh double-claim
- Không có admin key — hoàn toàn permissionless

---

## 📄 License

MIT
