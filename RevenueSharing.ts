import {
  Address,
  Blockchain,
  BytesWriter,
  Calldata,
  OP_NET,
  encodeSelector,
  Selector,
  NetEvent,
  StoredU256,
  StoredU16,
  StoredBoolean,
  AddressMemoryMap,
  MemorySlotPointer,
} from '@btc-vision/btc-runtime/runtime';
import { u256 } from 'as-bignum/assembly';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_SLOTS: u16 = 100;
const AUCTION_DURATION_BLOCKS: u64 = 144; // ~1 ngày trên Bitcoin (144 blocks)

// ─── Events ───────────────────────────────────────────────────────────────────

class SlotBidEvent extends NetEvent {
  constructor(slotId: u16, bidder: Address, amount: u256) {
    const writer = new BytesWriter(2 + 32 + 32);
    writer.writeU16(slotId);
    writer.writeAddress(bidder);
    writer.writeU256(amount);
    super('SlotBid', writer);
  }
}

class SlotClaimedEvent extends NetEvent {
  constructor(slotId: u16, owner: Address) {
    const writer = new BytesWriter(2 + 32);
    writer.writeU16(slotId);
    writer.writeAddress(owner);
    super('SlotClaimed', writer);
  }
}

class RevenueDistributedEvent extends NetEvent {
  constructor(totalAmount: u256, perSlot: u256, slotCount: u16) {
    const writer = new BytesWriter(32 + 32 + 2);
    writer.writeU256(totalAmount);
    writer.writeU256(perSlot);
    writer.writeU16(slotCount);
    super('RevenueDistributed', writer);
  }
}

class RevenueClaimedEvent extends NetEvent {
  constructor(claimer: Address, amount: u256, slotsOwned: u16) {
    const writer = new BytesWriter(32 + 32 + 2);
    writer.writeAddress(claimer);
    writer.writeU256(amount);
    writer.writeU16(slotsOwned);
    super('RevenueClaimed', writer);
  }
}

class AuctionStartedEvent extends NetEvent {
  constructor(tokenAddress: Address, startBlock: u64, endBlock: u64) {
    const writer = new BytesWriter(32 + 8 + 8);
    writer.writeAddress(tokenAddress);
    writer.writeU64(startBlock);
    writer.writeU64(endBlock);
    super('AuctionStarted', writer);
  }
}

// ─── RevenueSharing Contract ──────────────────────────────────────────────────
//
// Cơ chế hoạt động:
// 1. Khi meme token được deploy, RevenueSharing được khởi tạo cùng
// 2. 100 slots được đấu giá trong 144 blocks
// 3. Người thắng đấu giá mỗi slot trở thành "slot owner"
// 4. Mỗi khi token được giao dịch, 1% fee chảy vào contract này
// 5. Fee được chia đều cho 100 slot owners
// 6. Slot owners có thể claim revenue bất cứ lúc nào

@final
export class RevenueSharing extends OP_NET {
  // ─── Storage Pointers ──────────────────────────────────────────────────────

  // Thông tin auction
  private static readonly AUCTION_START_BLOCK_PTR: u16 = 200;
  private static readonly AUCTION_END_BLOCK_PTR: u16 = 201;
  private static readonly AUCTION_ACTIVE_PTR: u16 = 202;
  private static readonly SLOTS_FILLED_PTR: u16 = 203;

  // Token liên kết
  private static readonly MEME_TOKEN_PTR: u16 = 210;
  private static readonly CREATOR_PTR: u16 = 211;

  // Revenue tracking
  private static readonly TOTAL_REVENUE_PTR: u16 = 220;
  private static readonly REVENUE_PER_SLOT_ACCUMULATED_PTR: u16 = 221;
  private static readonly TOTAL_DISTRIBUTED_PTR: u16 = 222;

  // Maps (slot_id → data) — dùng sub-pointers
  // Pointer 300: slot owner address (slot_id as sub-pointer)
  // Pointer 301: highest bid per slot
  // Pointer 302: highest bidder per slot
  // Pointer 303: revenue claimed per slot
  // Pointer 304: revenue checkpoint per slot (accumulated tại lúc claim gần nhất)

  private static readonly SLOT_OWNER_MAP_PTR: u16 = 300;
  private static readonly SLOT_HIGHEST_BID_PTR: u16 = 301;
  private static readonly SLOT_HIGHEST_BIDDER_PTR: u16 = 302;
  private static readonly SLOT_REVENUE_CLAIMED_PTR: u16 = 303;
  private static readonly SLOT_CHECKPOINT_PTR: u16 = 304;

  // ─── Stored fields ─────────────────────────────────────────────────────────

  private _auctionStartBlock: StoredU256 = new StoredU256(RevenueSharing.AUCTION_START_BLOCK_PTR, u256.Zero);
  private _auctionEndBlock: StoredU256 = new StoredU256(RevenueSharing.AUCTION_END_BLOCK_PTR, u256.Zero);
  private _auctionActive: StoredBoolean = new StoredBoolean(RevenueSharing.AUCTION_ACTIVE_PTR, false);
  private _slotsFilled: StoredU256 = new StoredU256(RevenueSharing.SLOTS_FILLED_PTR, u256.Zero);

  private _memeToken: StoredU256 = new StoredU256(RevenueSharing.MEME_TOKEN_PTR, u256.Zero);
  private _creator: StoredU256 = new StoredU256(RevenueSharing.CREATOR_PTR, u256.Zero);

  private _totalRevenue: StoredU256 = new StoredU256(RevenueSharing.TOTAL_REVENUE_PTR, u256.Zero);
  private _revenuePerSlotAccumulated: StoredU256 = new StoredU256(RevenueSharing.REVENUE_PER_SLOT_ACCUMULATED_PTR, u256.Zero);
  private _totalDistributed: StoredU256 = new StoredU256(RevenueSharing.TOTAL_DISTRIBUTED_PTR, u256.Zero);

  // ─── Sub-pointer maps ──────────────────────────────────────────────────────

  private slotOwners: AddressMemoryMap<u256> = new AddressMemoryMap<u256>(
    RevenueSharing.SLOT_OWNER_MAP_PTR
  );
  private slotHighestBid: AddressMemoryMap<u256> = new AddressMemoryMap<u256>(
    RevenueSharing.SLOT_HIGHEST_BID_PTR
  );
  private slotHighestBidder: AddressMemoryMap<u256> = new AddressMemoryMap<u256>(
    RevenueSharing.SLOT_HIGHEST_BIDDER_PTR
  );
  private slotRevenueClaimed: AddressMemoryMap<u256> = new AddressMemoryMap<u256>(
    RevenueSharing.SLOT_REVENUE_CLAIMED_PTR
  );
  private slotCheckpoint: AddressMemoryMap<u256> = new AddressMemoryMap<u256>(
    RevenueSharing.SLOT_CHECKPOINT_PTR
  );

  public constructor() {
    super();
  }

  // ─── Deploy ────────────────────────────────────────────────────────────────

  public override onDeployment(calldata: Calldata): void {
    const memeTokenAddr: Address = calldata.readAddress();
    const creator: Address = Blockchain.tx.origin;

    // Lưu token address và creator
    this._memeToken.value = u256.fromBytes(memeTokenAddr.toBytes(), true);
    this._creator.value = u256.fromBytes(creator.toBytes(), true);

    // Bắt đầu auction ngay khi deploy
    const startBlock = Blockchain.blockNumber;
    const endBlock: u256 = u256.add(startBlock, u256.fromU64(AUCTION_DURATION_BLOCKS));

    this._auctionStartBlock.value = startBlock;
    this._auctionEndBlock.value = endBlock;
    this._auctionActive.value = true;

    const tokenAddr = Address.fromBytes(memeTokenAddr.toBytes());
    this.emitEvent(new AuctionStartedEvent(
      tokenAddr,
      startBlock.toU64(),
      endBlock.toU64()
    ));
  }

  // ─── Execute ───────────────────────────────────────────────────────────────

  public override execute(method: Selector, calldata: Calldata): BytesWriter {
    switch (method) {
      // Auction functions
      case encodeSelector('bidSlot(uint16)'):
        return this.bidSlot(calldata);
      case encodeSelector('finalizeAuction()'):
        return this.finalizeAuction();
      case encodeSelector('claimSlot(uint16)'):
        return this.claimSlot(calldata);

      // Revenue functions
      case encodeSelector('receiveRevenue(uint256)'):
        return this.receiveRevenue(calldata);
      case encodeSelector('claimRevenue()'):
        return this.claimRevenue();

      // View functions
      case encodeSelector('getSlotInfo(uint16)'):
        return this.getSlotInfo(calldata);
      case encodeSelector('getPendingRevenue(address)'):
        return this.getPendingRevenue(calldata);
      case encodeSelector('getAuctionInfo()'):
        return this.getAuctionInfo();
      case encodeSelector('getTotalRevenue()'):
        return this.getTotalRevenueInfo();
      case encodeSelector('getSlotsByOwner(address)'):
        return this.getSlotsByOwner(calldata);

      default:
        return super.execute(method, calldata);
    }
  }

  // ─── Auction: Đặt bid cho slot ─────────────────────────────────────────────

  private bidSlot(calldata: Calldata): BytesWriter {
    const slotId: u16 = calldata.readU16();
    const bidAmount: u256 = calldata.readU256(); // số token bid (đơn vị: satoshi BTC)

    // Kiểm tra auction còn active không
    assert(this._auctionActive.value, 'Auction is not active');
    assert(
      u256.le(Blockchain.blockNumber, this._auctionEndBlock.value),
      'Auction has ended'
    );

    // Kiểm tra slot hợp lệ
    assert(slotId < MAX_SLOTS, 'Invalid slot ID');

    // Lấy bid hiện tại cao nhất của slot này
    const slotKey = u256.fromU64(slotId as u64);
    const currentHighestBid = this.slotHighestBid.get(slotKey) || u256.Zero;

    // Bid mới phải cao hơn bid cũ ít nhất 5%
    const minBid = u256.add(
      currentHighestBid,
      u256.div(currentHighestBid, u256.fromU64(20)) // +5%
    );

    assert(
      u256.gt(bidAmount, minBid) || u256.eq(currentHighestBid, u256.Zero),
      'Bid must be at least 5% higher than current bid'
    );

    // Lưu bid mới
    this.slotHighestBid.set(slotKey, bidAmount);
    const bidderBytes = u256.fromBytes(Blockchain.tx.sender.toBytes(), true);
    this.slotHighestBidder.set(slotKey, bidderBytes);

    this.emitEvent(new SlotBidEvent(slotId, Blockchain.tx.sender, bidAmount));

    const writer = new BytesWriter(1);
    writer.writeBoolean(true);
    return writer;
  }

  // ─── Finalize Auction: kết thúc đấu giá, xác nhận winners ─────────────────

  private finalizeAuction(): BytesWriter {
    assert(this._auctionActive.value, 'Auction not active');
    assert(
      u256.gt(Blockchain.blockNumber, this._auctionEndBlock.value),
      'Auction still ongoing'
    );

    this._auctionActive.value = false;

    const writer = new BytesWriter(1);
    writer.writeBoolean(true);
    return writer;
  }

  // ─── Claim Slot: người thắng đấu giá lấy slot ──────────────────────────────

  private claimSlot(calldata: Calldata): BytesWriter {
    const slotId: u16 = calldata.readU16();

    assert(!this._auctionActive.value, 'Auction still active, finalize first');

    const slotKey = u256.fromU64(slotId as u64);
    const bidderBytes = this.slotHighestBidder.get(slotKey);

    assert(bidderBytes !== null, 'No bidder for this slot');

    const bidder = Address.fromBytes(bidderBytes!.toBytes());
    assert(
      bidder.equals(Blockchain.tx.sender),
      'Only the highest bidder can claim this slot'
    );

    // Kiểm tra chưa có owner (chưa bị claim)
    const existingOwner = this.slotOwners.get(slotKey);
    assert(existingOwner === null, 'Slot already claimed');

    // Set slot owner
    const ownerBytes = u256.fromBytes(Blockchain.tx.sender.toBytes(), true);
    this.slotOwners.set(slotKey, ownerBytes);

    // Set checkpoint để track revenue từ thời điểm này
    this.slotCheckpoint.set(slotKey, this._revenuePerSlotAccumulated.value);

    // Tăng số slot đã fill
    this._slotsFilled.value = u256.add(this._slotsFilled.value, u256.One);

    this.emitEvent(new SlotClaimedEvent(slotId, Blockchain.tx.sender));

    const writer = new BytesWriter(1);
    writer.writeBoolean(true);
    return writer;
  }

  // ─── Receive Revenue: được gọi khi có phí giao dịch từ MemeToken ───────────

  private receiveRevenue(calldata: Calldata): BytesWriter {
    const amount: u256 = calldata.readU256();
    const caller: Address = Blockchain.tx.sender;

    // Chỉ MemeToken mới được gọi
    const memeTokenAddr = Address.fromBytes(this._memeToken.value.toBytes());
    assert(caller.equals(memeTokenAddr), 'Only MemeToken can deposit revenue');

    if (u256.eq(amount, u256.Zero)) {
      const writer = new BytesWriter(1);
      writer.writeBoolean(false);
      return writer;
    }

    // Cập nhật tổng revenue
    this._totalRevenue.value = u256.add(this._totalRevenue.value, amount);

    // Tính revenue per slot (chia đều 100 slots)
    const slotCount = u256.fromU64(MAX_SLOTS as u64);
    const perSlot: u256 = u256.div(amount, slotCount);

    // Cộng vào accumulated (per-slot tracker)
    this._revenuePerSlotAccumulated.value = u256.add(
      this._revenuePerSlotAccumulated.value,
      perSlot
    );

    this.emitEvent(new RevenueDistributedEvent(amount, perSlot, MAX_SLOTS));

    const writer = new BytesWriter(1);
    writer.writeBoolean(true);
    return writer;
  }

  // ─── Claim Revenue: slot owner rút phần lợi nhuận của mình ────────────────

  private claimRevenue(): BytesWriter {
    const claimer: Address = Blockchain.tx.sender;
    let totalClaim: u256 = u256.Zero;
    let slotsOwned: u16 = 0;

    // Duyệt qua 100 slots để tìm slot của người này
    for (let i: u16 = 0; i < MAX_SLOTS; i++) {
      const slotKey = u256.fromU64(i as u64);
      const ownerBytes = this.slotOwners.get(slotKey);

      if (ownerBytes !== null) {
        const owner = Address.fromBytes(ownerBytes!.toBytes());
        if (owner.equals(claimer)) {
          slotsOwned++;

          // Tính pending revenue cho slot này
          const checkpoint = this.slotCheckpoint.get(slotKey) || u256.Zero;
          const currentAccumulated = this._revenuePerSlotAccumulated.value;
          const pendingPerSlot: u256 = u256.sub(currentAccumulated, checkpoint!);

          if (u256.gt(pendingPerSlot, u256.Zero)) {
            totalClaim = u256.add(totalClaim, pendingPerSlot);

            // Cập nhật checkpoint
            this.slotCheckpoint.set(slotKey, currentAccumulated);
          }
        }
      }
    }

    assert(u256.gt(totalClaim, u256.Zero), 'No revenue to claim');

    // Cập nhật tổng đã distribute
    this._totalDistributed.value = u256.add(this._totalDistributed.value, totalClaim);

    // TODO: Thực tế cần transfer token về cho claimer
    // Hiện tại emit event để frontend xử lý
    this.emitEvent(new RevenueClaimedEvent(claimer, totalClaim, slotsOwned));

    const writer = new BytesWriter(32 + 2);
    writer.writeU256(totalClaim);
    writer.writeU16(slotsOwned);
    return writer;
  }

  // ─── View: thông tin một slot ───────────────────────────────────────────────

  private getSlotInfo(calldata: Calldata): BytesWriter {
    const slotId: u16 = calldata.readU16();
    const slotKey = u256.fromU64(slotId as u64);

    const ownerBytes = this.slotOwners.get(slotKey);
    const highestBid = this.slotHighestBid.get(slotKey) || u256.Zero;
    const highestBidderBytes = this.slotHighestBidder.get(slotKey);
    const claimed = ownerBytes !== null;

    const writer = new BytesWriter(1 + 32 + 32 + 32);
    writer.writeBoolean(claimed);
    writer.writeU256(highestBid!);

    if (highestBidderBytes !== null) {
      const bidderAddr = Address.fromBytes(highestBidderBytes!.toBytes());
      writer.writeAddress(bidderAddr);
    } else {
      writer.writeAddress(Address.dead());
    }

    if (ownerBytes !== null) {
      const ownerAddr = Address.fromBytes(ownerBytes!.toBytes());
      writer.writeAddress(ownerAddr);
    } else {
      writer.writeAddress(Address.dead());
    }

    return writer;
  }

  // ─── View: pending revenue của một address ─────────────────────────────────

  private getPendingRevenue(calldata: Calldata): BytesWriter {
    const user: Address = calldata.readAddress();
    let pending: u256 = u256.Zero;
    let slotsOwned: u16 = 0;

    for (let i: u16 = 0; i < MAX_SLOTS; i++) {
      const slotKey = u256.fromU64(i as u64);
      const ownerBytes = this.slotOwners.get(slotKey);

      if (ownerBytes !== null) {
        const owner = Address.fromBytes(ownerBytes!.toBytes());
        if (owner.equals(user)) {
          slotsOwned++;
          const checkpoint = this.slotCheckpoint.get(slotKey) || u256.Zero;
          const diff = u256.sub(this._revenuePerSlotAccumulated.value, checkpoint!);
          pending = u256.add(pending, diff);
        }
      }
    }

    const writer = new BytesWriter(32 + 2);
    writer.writeU256(pending);
    writer.writeU16(slotsOwned);
    return writer;
  }

  // ─── View: thông tin auction ────────────────────────────────────────────────

  private getAuctionInfo(): BytesWriter {
    const writer = new BytesWriter(1 + 32 + 32 + 32);
    writer.writeBoolean(this._auctionActive.value);
    writer.writeU256(this._auctionStartBlock.value);
    writer.writeU256(this._auctionEndBlock.value);
    writer.writeU256(this._slotsFilled.value);
    return writer;
  }

  // ─── View: tổng revenue ─────────────────────────────────────────────────────

  private getTotalRevenueInfo(): BytesWriter {
    const writer = new BytesWriter(32 + 32 + 32);
    writer.writeU256(this._totalRevenue.value);
    writer.writeU256(this._totalDistributed.value);
    writer.writeU256(this._revenuePerSlotAccumulated.value);
    return writer;
  }

  // ─── View: tất cả slot của một owner ────────────────────────────────────────

  private getSlotsByOwner(calldata: Calldata): BytesWriter {
    const user: Address = calldata.readAddress();
    const ownedSlots: u16[] = [];

    for (let i: u16 = 0; i < MAX_SLOTS; i++) {
      const slotKey = u256.fromU64(i as u64);
      const ownerBytes = this.slotOwners.get(slotKey);
      if (ownerBytes !== null) {
        const owner = Address.fromBytes(ownerBytes!.toBytes());
        if (owner.equals(user)) {
          ownedSlots.push(i);
        }
      }
    }

    const writer = new BytesWriter(2 + ownedSlots.length * 2);
    writer.writeU16(ownedSlots.length as u16);
    for (let i = 0; i < ownedSlots.length; i++) {
      writer.writeU16(ownedSlots[i]);
    }
    return writer;
  }
}
