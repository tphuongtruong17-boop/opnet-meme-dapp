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
  AddressMemoryMap,
} from '@btc-vision/btc-runtime/runtime';
import { u256 } from 'as-bignum/assembly';

// ─── Constants ────────────────────────────────────────────────────────────────

// Phí tạo meme: 10,000 satoshi (~0.0001 BTC)
const PROTOCOL_FEE: u64 = 10000;

// Giá sàn slot tối thiểu: 500 satoshi
const MIN_FLOOR_PRICE: u64 = 500;

// ─── Events ───────────────────────────────────────────────────────────────────

class MemeRegisteredEvent extends NetEvent {
  constructor(
    index: u256,
    creator: Address,
    tokenAddress: Address,
    revenueAddress: Address,
    name: string,
    symbol: string,
    floorPrice: u256,
    imageUrl: string,
  ) {
    const nameBytes   = Uint8Array.wrap(String.UTF8.encode(name));
    const symbolBytes = Uint8Array.wrap(String.UTF8.encode(symbol));
    const imgBytes    = Uint8Array.wrap(String.UTF8.encode(imageUrl));

    const w = new BytesWriter(
      32 + 32 + 32 + 32 + 32 +
      2 + nameBytes.length +
      2 + symbolBytes.length +
      2 + imgBytes.length
    );
    w.writeU256(index);
    w.writeAddress(creator);
    w.writeAddress(tokenAddress);
    w.writeAddress(revenueAddress);
    w.writeU256(floorPrice);
    w.writeStringWithLength(name);
    w.writeStringWithLength(symbol);
    w.writeStringWithLength(imageUrl);
    super('MemeRegistered', w);
  }
}

class ProtocolFeeCollectedEvent extends NetEvent {
  constructor(from: Address, amount: u256) {
    const w = new BytesWriter(32 + 32);
    w.writeAddress(from);
    w.writeU256(amount);
    super('ProtocolFeeCollected', w);
  }
}

// ─── MemeFactoryV2 ────────────────────────────────────────────────────────────
//
// Ai cũng có thể đăng ký meme token của họ vào factory này.
// Mỗi meme gồm:
//   - MemeToken (OP_20, đã deploy riêng)
//   - RevenueSharingV2 (đã deploy riêng, 100 slots)
//   - Metadata: name, symbol, imageUrl, description
//   - floorPrice: creator tự đặt (≥ MIN_FLOOR_PRICE)
//
// Phí protocol: PROTOCOL_FEE satoshi mỗi lần tạo meme
// Phí đi về treasury address của protocol

@final
export class MemeFactoryV2 extends OP_NET {

  // ── Core storage ─────────────────────────────────────────
  private static readonly TOTAL_MEMES_PTR: u16    = 500;
  private static readonly TREASURY_PTR: u16       = 501;
  private static readonly PROTOCOL_FEE_PTR: u16   = 502;
  private static readonly TOTAL_FEE_EARNED_PTR: u16 = 503;

  // ── Per-meme maps (key = meme index u256) ────────────────
  private static readonly MEME_TOKEN_PTR: u16     = 600; // index → tokenAddress
  private static readonly MEME_REVENUE_PTR: u16   = 601; // index → revenueAddress
  private static readonly MEME_CREATOR_PTR: u16   = 602; // index → creatorAddress
  private static readonly MEME_FLOOR_PTR: u16     = 603; // index → floorPrice
  private static readonly MEME_NAME_PTR: u16      = 604; // index → name (encoded)
  private static readonly MEME_SYMBOL_PTR: u16    = 605; // index → symbol
  private static readonly MEME_IMAGE_PTR: u16     = 606; // index → imageUrl
  private static readonly MEME_TAKEOVERS_PTR: u16 = 607; // index → takeover count (hot metric)
  private static readonly MEME_CREATED_PTR: u16   = 608; // index → created block

  // ── Creator → meme list ──────────────────────────────────
  // creatorAddress → count of memes created
  private static readonly CREATOR_COUNT_PTR: u16  = 700;
  // creatorAddress_index → meme global index
  private static readonly CREATOR_MEMES_PTR: u16  = 701;

  // ── Stored fields ────────────────────────────────────────
  private _totalMemes:     StoredU256 = new StoredU256(MemeFactoryV2.TOTAL_MEMES_PTR, u256.Zero);
  private _treasury:       StoredU256 = new StoredU256(MemeFactoryV2.TREASURY_PTR, u256.Zero);
  private _protocolFee:    StoredU256 = new StoredU256(MemeFactoryV2.PROTOCOL_FEE_PTR, u256.fromU64(PROTOCOL_FEE));
  private _totalFeeEarned: StoredU256 = new StoredU256(MemeFactoryV2.TOTAL_FEE_EARNED_PTR, u256.Zero);

  private memeToken:     AddressMemoryMap<u256> = new AddressMemoryMap<u256>(MemeFactoryV2.MEME_TOKEN_PTR);
  private memeRevenue:   AddressMemoryMap<u256> = new AddressMemoryMap<u256>(MemeFactoryV2.MEME_REVENUE_PTR);
  private memeCreator:   AddressMemoryMap<u256> = new AddressMemoryMap<u256>(MemeFactoryV2.MEME_CREATOR_PTR);
  private memeFloor:     AddressMemoryMap<u256> = new AddressMemoryMap<u256>(MemeFactoryV2.MEME_FLOOR_PTR);
  private memeName:      AddressMemoryMap<u256> = new AddressMemoryMap<u256>(MemeFactoryV2.MEME_NAME_PTR);
  private memeSymbol:    AddressMemoryMap<u256> = new AddressMemoryMap<u256>(MemeFactoryV2.MEME_SYMBOL_PTR);
  private memeImage:     AddressMemoryMap<u256> = new AddressMemoryMap<u256>(MemeFactoryV2.MEME_IMAGE_PTR);
  private memeTakeovers: AddressMemoryMap<u256> = new AddressMemoryMap<u256>(MemeFactoryV2.MEME_TAKEOVERS_PTR);
  private memeCreated:   AddressMemoryMap<u256> = new AddressMemoryMap<u256>(MemeFactoryV2.MEME_CREATED_PTR);

  private creatorCount: AddressMemoryMap<u256> = new AddressMemoryMap<u256>(MemeFactoryV2.CREATOR_COUNT_PTR);
  private creatorMemes: AddressMemoryMap<u256> = new AddressMemoryMap<u256>(MemeFactoryV2.CREATOR_MEMES_PTR);

  public constructor() { super(); }

  // ─── Deploy ──────────────────────────────────────────────

  public override onDeployment(calldata: Calldata): void {
    const treasury: Address = calldata.readAddress();
    this._treasury.value = u256.fromBytes(treasury.toBytes(), true);
  }

  // ─── Execute ─────────────────────────────────────────────

  public override execute(method: Selector, calldata: Calldata): BytesWriter {
    switch (method) {
      case encodeSelector('registerMeme(address,address,string,string,string,string,uint256)'):
        return this.registerMeme(calldata);
      case encodeSelector('incrementTakeover(uint256)'):
        return this.incrementTakeover(calldata);
      case encodeSelector('getMeme(uint256)'):
        return this.getMeme(calldata);
      case encodeSelector('getMemeCount()'):
        return this.getMemeCount();
      case encodeSelector('getMemesByCreator(address,uint256,uint256)'):
        return this.getMemesByCreator(calldata);
      case encodeSelector('getMemesPaginated(uint256,uint256)'):
        return this.getMemesPaginated(calldata);
      case encodeSelector('getHotMemes(uint256)'):
        return this.getHotMemes(calldata);
      case encodeSelector('getProtocolFee()'):
        return this.getProtocolFee();
      default:
        return super.execute(method, calldata);
    }
  }

  // ─── Register meme ────────────────────────────────────────
  // Người dùng deploy MemeToken + RevenueSharingV2 trước,
  // sau đó gọi registerMeme() để đưa vào factory directory

  private registerMeme(calldata: Calldata): BytesWriter {
    const tokenAddr:   Address = calldata.readAddress();
    const revenueAddr: Address = calldata.readAddress();
    const name:        string  = calldata.readStringWithLength();
    const symbol:      string  = calldata.readStringWithLength();
    const imageUrl:    string  = calldata.readStringWithLength();
    const description: string  = calldata.readStringWithLength();
    const floorPrice:  u256    = calldata.readU256();

    const creator: Address = Blockchain.tx.sender;

    // Kiểm tra floor price tối thiểu
    assert(
      u256.ge(floorPrice, u256.fromU64(MIN_FLOOR_PRICE)),
      'Floor price below minimum (500 sat)'
    );

    // Kiểm tra protocol fee đã được thanh toán
    // Trong OP_NET: kiểm tra tx.value hoặc đã approve transfer
    // Đây là placeholder — thực tế cần tích hợp với BTC transfer
    const feePaid: u256 = calldata.readU256(); // số sat đã gửi kèm
    assert(
      u256.ge(feePaid, this._protocolFee.value),
      'Protocol fee not paid'
    );

    // Lưu protocol fee về treasury
    const treasuryAddr = Address.fromBytes(this._treasury.value.toBytes());
    this._totalFeeEarned.value = u256.add(this._totalFeeEarned.value, this._protocolFee.value);
    this.emitEvent(new ProtocolFeeCollectedEvent(creator, this._protocolFee.value));

    // Lấy index mới
    const index = this._totalMemes.value;

    // Lưu metadata
    const tokenBytes   = u256.fromBytes(tokenAddr.toBytes(), true);
    const revenueBytes = u256.fromBytes(revenueAddr.toBytes(), true);
    const creatorBytes = u256.fromBytes(creator.toBytes(), true);

    this.memeToken.set(index, tokenBytes);
    this.memeRevenue.set(index, revenueBytes);
    this.memeCreator.set(index, creatorBytes);
    this.memeFloor.set(index, floorPrice);
    this.memeTakeovers.set(index, u256.Zero);
    this.memeCreated.set(index, Blockchain.blockNumber);

    // Encode name/symbol/image như u256 array (đơn giản hoá)
    // Thực tế: dùng storage map riêng cho strings
    const nameHash   = this._hashString(name);
    const symbolHash = this._hashString(symbol);
    const imageHash  = this._hashString(imageUrl);
    this.memeName.set(index, nameHash);
    this.memeSymbol.set(index, symbolHash);
    this.memeImage.set(index, imageHash);

    // Thêm vào creator list
    const creatorKey = creatorBytes;
    const creatorCnt = this.creatorCount.get(creatorKey) || u256.Zero;
    const creatorIdx = u256.add(
      u256.mul(creatorKey, u256.fromU64(10000)),
      creatorCnt!
    );
    this.creatorMemes.set(creatorIdx, index);
    this.creatorCount.set(creatorKey, u256.add(creatorCnt!, u256.One));

    // Tăng tổng meme count
    this._totalMemes.value = u256.add(index, u256.One);

    this.emitEvent(new MemeRegisteredEvent(
      index, creator, tokenAddr, revenueAddr,
      name, symbol, floorPrice, imageUrl
    ));

    const writer = new BytesWriter(32);
    writer.writeU256(index);
    return writer;
  }

  // ─── Increment takeover count (gọi bởi RevenueSharingV2) ──

  private incrementTakeover(calldata: Calldata): BytesWriter {
    const memeIndex: u256 = calldata.readU256();
    const current = this.memeTakeovers.get(memeIndex) || u256.Zero;
    this.memeTakeovers.set(memeIndex, u256.add(current!, u256.One));

    const writer = new BytesWriter(1);
    writer.writeBoolean(true);
    return writer;
  }

  // ─── Get meme info ────────────────────────────────────────

  private getMeme(calldata: Calldata): BytesWriter {
    const index: u256 = calldata.readU256();
    assert(u256.lt(index, this._totalMemes.value), 'Meme not found');

    const tokenBytes   = this.memeToken.get(index)   || u256.Zero;
    const revenueBytes = this.memeRevenue.get(index)  || u256.Zero;
    const creatorBytes = this.memeCreator.get(index)  || u256.Zero;
    const floorPrice   = this.memeFloor.get(index)    || u256.Zero;
    const takeovers    = this.memeTakeovers.get(index) || u256.Zero;
    const createdBlock = this.memeCreated.get(index)  || u256.Zero;

    const writer = new BytesWriter(32 + 32 + 32 + 32 + 32 + 32 + 32);
    writer.writeU256(index);
    writer.writeAddress(Address.fromBytes(tokenBytes!.toBytes()));
    writer.writeAddress(Address.fromBytes(revenueBytes!.toBytes()));
    writer.writeAddress(Address.fromBytes(creatorBytes!.toBytes()));
    writer.writeU256(floorPrice!);
    writer.writeU256(takeovers!);
    writer.writeU256(createdBlock!);
    return writer;
  }

  private getMemeCount(): BytesWriter {
    const writer = new BytesWriter(32);
    writer.writeU256(this._totalMemes.value);
    return writer;
  }

  // ─── Paginated list (newest first) ───────────────────────

  private getMemesPaginated(calldata: Calldata): BytesWriter {
    const offset: u256 = calldata.readU256();
    const limit: u256  = calldata.readU256();
    const total = this._totalMemes.value;

    // Giới hạn 20 meme mỗi trang
    const safeLimit = u256.lt(limit, u256.fromU64(20)) ? limit : u256.fromU64(20);

    const writer = new BytesWriter(32 + 32 + 20 * 32);
    writer.writeU256(total);
    writer.writeU256(safeLimit);

    let count: u8 = 0;
    let i = u256.gt(total, u256.Zero)
      ? u256.sub(total, u256.One)
      : u256.Zero;

    // Skip offset
    if (u256.gt(offset, u256.Zero) && u256.ge(i, offset)) {
      i = u256.sub(i, offset);
    }

    while (u256.ge(i, u256.Zero) && count < 20) {
      if (u256.lt(u256.fromU64(count), safeLimit)) {
        writer.writeU256(i);
        count++;
      }
      if (u256.eq(i, u256.Zero)) break;
      i = u256.sub(i, u256.One);
    }

    return writer;
  }

  // ─── Hot memes (sorted by takeover count) ────────────────

  private getHotMemes(calldata: Calldata): BytesWriter {
    const topN: u256 = calldata.readU256();
    const total = this._totalMemes.value;
    const n = u256.lt(topN, u256.fromU64(20)) ? topN.toU64() as u8 : 20 as u8;

    // Simple selection sort trên top N
    // Với số meme lớn nên làm off-chain và cache
    const indices: u64[] = [];
    const scores: u64[]  = [];

    const count = u256.lt(total, u256.fromU64(100))
      ? total.toU64() as u8
      : 100 as u8;

    for (let i: u8 = 0; i < count; i++) {
      const idx = u256.fromU64(i as u64);
      const tk  = this.memeTakeovers.get(idx) || u256.Zero;
      indices.push(i as u64);
      scores.push(tk!.toU64());
    }

    // Bubble sort giảm dần theo scores (chỉ dùng cho list nhỏ)
    for (let i = 0; i < scores.length - 1; i++) {
      for (let j = 0; j < scores.length - i - 1; j++) {
        if (scores[j] < scores[j + 1]) {
          const tmpS = scores[j]; scores[j] = scores[j+1]; scores[j+1] = tmpS;
          const tmpI = indices[j]; indices[j] = indices[j+1]; indices[j+1] = tmpI;
        }
      }
    }

    const writer = new BytesWriter(32 + n * 32);
    writer.writeU256(u256.fromU64(n as u64));
    for (let i: u8 = 0; i < n && i < indices.length as u8; i++) {
      writer.writeU256(u256.fromU64(indices[i]));
    }
    return writer;
  }

  // ─── Memes by creator ────────────────────────────────────

  private getMemesByCreator(calldata: Calldata): BytesWriter {
    const creator: Address = calldata.readAddress();
    const offset: u256     = calldata.readU256();
    const limit: u256      = calldata.readU256();

    const creatorBytes = u256.fromBytes(creator.toBytes(), true);
    const total = this.creatorCount.get(creatorBytes) || u256.Zero;
    const safeLimit = u256.lt(limit, u256.fromU64(20)) ? limit : u256.fromU64(20);

    const writer = new BytesWriter(32 + 32 + 20 * 32);
    writer.writeU256(total!);
    writer.writeU256(safeLimit);

    let count: u8 = 0;
    let i = offset;
    while (u256.lt(i, total!) && count < 20) {
      const creatorIdx = u256.add(
        u256.mul(creatorBytes, u256.fromU64(10000)),
        i
      );
      const memeIdx = this.creatorMemes.get(creatorIdx);
      if (memeIdx !== null) {
        writer.writeU256(memeIdx!);
        count++;
      }
      i = u256.add(i, u256.One);
    }
    return writer;
  }

  private getProtocolFee(): BytesWriter {
    const writer = new BytesWriter(32 + 32);
    writer.writeU256(this._protocolFee.value);
    writer.writeU256(this._totalFeeEarned.value);
    return writer;
  }

  // ─── Helper: hash string thành u256 (FNV-1a) ─────────────
  private _hashString(s: string): u256 {
    const bytes = Uint8Array.wrap(String.UTF8.encode(s));
    let hash: u64 = 14695981039346656037;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i] as u64;
      hash = hash * 1099511628211;
    }
    return u256.fromU64(hash);
  }
}
