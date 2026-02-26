import {
  Address,
  Blockchain,
  BytesWriter,
  Calldata,
  DeployableOP_20,
  encodeSelector,
  OP20InitParameters,
  Selector,
  NetEvent,
  StoredU256,
  AddressMemoryMap,
} from '@btc-vision/btc-runtime/runtime';
import { u128, u256 } from 'as-bignum/assembly';

// ─── Events ───────────────────────────────────────────────────────────────────

class FeeCollectedEvent extends NetEvent {
  constructor(from: Address, to: Address, feeAmount: u256) {
    const writer = new BytesWriter(32 + 32 + 32);
    writer.writeAddress(from);
    writer.writeAddress(to);
    writer.writeU256(feeAmount);
    super('FeeCollected', writer);
  }
}

class TransferWithFeeEvent extends NetEvent {
  constructor(from: Address, to: Address, amount: u256, fee: u256) {
    const writer = new BytesWriter(32 + 32 + 32 + 32);
    writer.writeAddress(from);
    writer.writeAddress(to);
    writer.writeU256(amount);
    writer.writeU256(fee);
    super('TransferWithFee', writer);
  }
}

// ─── MemeToken Contract ────────────────────────────────────────────────────────
// - OP_20 token chuẩn
// - Mỗi giao dịch transfer thu 1% fee
// - Fee được gửi vào RevenueSharing contract
// - Tổng supply: 1 tỷ token (18 decimals)

@final
export class MemeToken extends DeployableOP_20 {
  // Pointers cho storage
  private static readonly REVENUE_CONTRACT_POINTER: u16 = 100;
  private static readonly TOTAL_FEES_POINTER: u16 = 101;
  private static readonly FEE_RATE_POINTER: u16 = 102; // basis points (100 = 1%)

  // Storage
  private _revenueSharingContract: StoredU256 = new StoredU256(
    MemeToken.REVENUE_CONTRACT_POINTER,
    u256.Zero
  );
  private _totalFeesCollected: StoredU256 = new StoredU256(
    MemeToken.TOTAL_FEES_POINTER,
    u256.Zero
  );
  private _feeRateBps: StoredU256 = new StoredU256(
    MemeToken.FEE_RATE_POINTER,
    u256.fromU64(100) // 1% mặc định
  );

  public constructor() {
    super();
    // Constructor chạy mỗi lần contract được gọi
  }

  // ─── Deploy (chạy 1 lần duy nhất) ──────────────────────────────────────────

  public override onDeployment(calldata: Calldata): void {
    // Đọc params từ calldata: name, symbol, revenueSharingAddress
    const name: string = calldata.readStringWithLength();
    const symbol: string = calldata.readStringWithLength();
    const revenueSharingAddr: Address = calldata.readAddress();

    const maxSupply: u256 = u128.fromString('1000000000000000000000000000').toU256(); // 1 tỷ token
    const decimals: u8 = 18;

    // Khởi tạo OP_20
    this.instantiate(new OP20InitParameters(maxSupply, decimals, name, symbol));

    // Lưu địa chỉ revenue sharing contract
    // Chuyển address thành u256 để lưu
    this._revenueSharingContract.value = u256.fromBytes(revenueSharingAddr.toBytes(), true);

    // Mint toàn bộ supply cho deployer
    this._mint(Blockchain.tx.origin, maxSupply);
  }

  // ─── Execute: routing các method calls ─────────────────────────────────────

  public override execute(method: Selector, calldata: Calldata): BytesWriter {
    switch (method) {
      case encodeSelector('transfer(address,uint256)'):
        return this.transferWithFee(calldata);
      case encodeSelector('transferFrom(address,address,uint256)'):
        return this.transferFromWithFee(calldata);
      case encodeSelector('getFeeRate()'):
        return this.getFeeRate();
      case encodeSelector('getTotalFeesCollected()'):
        return this.getTotalFeesCollected();
      case encodeSelector('getRevenueContract()'):
        return this.getRevenueContract();
      default:
        return super.execute(method, calldata);
    }
  }

  // ─── Transfer với 1% fee ────────────────────────────────────────────────────

  private transferWithFee(calldata: Calldata): BytesWriter {
    const to: Address = calldata.readAddress();
    const amount: u256 = calldata.readU256();
    const from: Address = Blockchain.tx.sender;

    // Tính fee: amount * feeRate / 10000
    const feeRate = this._feeRateBps.value;
    const fee: u256 = u256.div(u256.mul(amount, feeRate), u256.fromU64(10000));
    const amountAfterFee: u256 = u256.sub(amount, fee);

    // Lấy địa chỉ revenue contract
    const revenueAddr = this._revenueSharingContract.value;

    // Transfer amount - fee cho người nhận
    this._transfer(from, to, amountAfterFee);

    // Transfer fee cho revenue contract
    if (u256.gt(fee, u256.Zero)) {
      const revenueAddress = Address.fromBytes(revenueAddr.toBytes());
      this._transfer(from, revenueAddress, fee);

      // Cập nhật tổng phí đã thu
      this._totalFeesCollected.value = u256.add(this._totalFeesCollected.value, fee);

      this.emitEvent(new FeeCollectedEvent(from, revenueAddress, fee));
    }

    this.emitEvent(new TransferWithFeeEvent(from, to, amountAfterFee, fee));

    const writer = new BytesWriter(1);
    writer.writeBoolean(true);
    return writer;
  }

  private transferFromWithFee(calldata: Calldata): BytesWriter {
    const from: Address = calldata.readAddress();
    const to: Address = calldata.readAddress();
    const amount: u256 = calldata.readU256();

    const feeRate = this._feeRateBps.value;
    const fee: u256 = u256.div(u256.mul(amount, feeRate), u256.fromU64(10000));
    const amountAfterFee: u256 = u256.sub(amount, fee);

    const revenueAddr = this._revenueSharingContract.value;

    // Kiểm tra và giảm allowance
    this._transferFrom(from, to, amountAfterFee);

    if (u256.gt(fee, u256.Zero)) {
      const revenueAddress = Address.fromBytes(revenueAddr.toBytes());
      this._transfer(from, revenueAddress, fee);
      this._totalFeesCollected.value = u256.add(this._totalFeesCollected.value, fee);
      this.emitEvent(new FeeCollectedEvent(from, revenueAddress, fee));
    }

    const writer = new BytesWriter(1);
    writer.writeBoolean(true);
    return writer;
  }

  // ─── View functions ─────────────────────────────────────────────────────────

  private getFeeRate(): BytesWriter {
    const writer = new BytesWriter(32);
    writer.writeU256(this._feeRateBps.value);
    return writer;
  }

  private getTotalFeesCollected(): BytesWriter {
    const writer = new BytesWriter(32);
    writer.writeU256(this._totalFeesCollected.value);
    return writer;
  }

  private getRevenueContract(): BytesWriter {
    const writer = new BytesWriter(32);
    writer.writeU256(this._revenueSharingContract.value);
    return writer;
  }
}
