# --- Dollar Cost Averaging (DCA) Focused Strategy ---
from freqtrade.strategy import IStrategy, DecimalParameter, IntParameter, BooleanParameter
from pandas import DataFrame
import talib.abstract as ta
import freqtrade.vendor.qtpylib.indicators as qtpylib
import logging
from typing import Optional
from freqtrade.persistence import Trade
from datetime import datetime, timedelta
import numpy as np

logger = logging.getLogger(__name__)


class DCAStrategy(IStrategy):
    """
    Dollar Cost Averaging (DCA) Strategy with Smart Entry and Risk Management
    
    This strategy focuses on:
    - Systematic dollar cost averaging on dips
    - Risk-managed position sizing
    - Multiple DCA levels with increasing allocation
    - Profit-taking at predetermined levels
    - Stop-loss protection with trailing stops
    """

    # Strategy interface version
    INTERFACE_VERSION = 3

    # Basic configuration
    timeframe = '1h'  # Longer timeframe for DCA approach
    can_short = False
    
    # ROI configuration for DCA strategy
    minimal_roi = {
        "0": 0.30,     # 30% profit target (DCA strategies can be more patient)
        "60": 0.20,    # 20% after 1 hour
        "180": 0.15,   # 15% after 3 hours
        "360": 0.10,   # 10% after 6 hours
        "720": 0.05,   # 5% after 12 hours
        "1440": 0.02   # 2% after 24 hours
    }

    # Conservative stoploss for DCA
    stoploss = -0.12  # -12% stoploss (more generous for DCA)
    
    # Trailing stop configuration
    trailing_stop = True
    trailing_stop_positive = 0.03  # Start trailing at +3%
    trailing_stop_positive_offset = 0.05  # Trail by 5%
    trailing_only_offset_is_reached = True

    # Strategy configuration
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False
    process_only_new_candles = True
    startup_candle_count: int = 100

    # === DCA CONFIGURATION PARAMETERS ===
    
    # DCA Entry Configuration
    dca_enabled = BooleanParameter(default=True, space="buy", optimize=False, load=True)
    dca_max_orders = IntParameter(3, 7, default=5, space="buy", optimize=False, load=True)
    
    # DCA Trigger Levels (when to place additional orders)
    dca_level_1 = DecimalParameter(-0.08, -0.03, default=-0.05, space="buy", optimize=False, load=True)
    dca_level_2 = DecimalParameter(-0.15, -0.08, default=-0.10, space="buy", optimize=False, load=True)
    dca_level_3 = DecimalParameter(-0.25, -0.15, default=-0.18, space="buy", optimize=False, load=True)
    dca_level_4 = DecimalParameter(-0.35, -0.25, default=-0.28, space="buy", optimize=False, load=True)
    
    # DCA Position Sizing (multipliers for each level)
    dca_size_multiplier_1 = DecimalParameter(1.0, 2.0, default=1.2, space="buy", optimize=False, load=True)
    dca_size_multiplier_2 = DecimalParameter(1.2, 2.5, default=1.5, space="buy", optimize=False, load=True)
    dca_size_multiplier_3 = DecimalParameter(1.5, 3.0, default=2.0, space="buy", optimize=False, load=True)
    dca_size_multiplier_4 = DecimalParameter(2.0, 4.0, default=2.5, space="buy", optimize=False, load=True)
    
    # Position Sizing
    base_position_size = DecimalParameter(0.08, 0.20, default=0.12, space="buy", optimize=False, load=True)
    max_position_size = DecimalParameter(0.30, 0.60, default=0.45, space="buy", optimize=False, load=True)
    
    # Risk Management
    max_total_allocation = DecimalParameter(0.20, 0.50, default=0.35, space="buy", optimize=False, load=True)
    max_drawdown_per_pair = DecimalParameter(0.15, 0.40, default=0.25, space="buy", optimize=False, load=True)
    
    # Entry Conditions
    use_market_trend_filter = BooleanParameter(default=True, space="buy", optimize=False, load=True)
    use_volatility_filter = BooleanParameter(default=True, space="buy", optimize=False, load=True)
    min_time_between_entries = IntParameter(2, 8, default=4, space="buy", optimize=False, load=True)  # hours
    
    # Technical Indicators for Entry Timing
    rsi_period = IntParameter(12, 18, default=14, space="buy", optimize=True)
    rsi_oversold = IntParameter(20, 35, default=28, space="buy", optimize=True)
    rsi_overbought = IntParameter(65, 80, default=72, space="sell", optimize=True)
    
    ema_short = IntParameter(12, 20, default=16, space="buy", optimize=True)
    ema_long = IntParameter(40, 60, default=50, space="buy", optimize=True)
    
    bb_period = IntParameter(18, 24, default=20, space="buy", optimize=False)
    bb_std = DecimalParameter(1.8, 2.4, default=2.0, space="buy", optimize=False)

    def informative_pairs(self):
        """No additional pairs needed for this strategy"""
        return []

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Add indicators for DCA strategy
        """
        # === TREND INDICATORS ===
        dataframe['ema_short'] = ta.EMA(dataframe, timeperiod=self.ema_short.value)
        dataframe['ema_long'] = ta.EMA(dataframe, timeperiod=self.ema_long.value)
        dataframe['sma_100'] = ta.SMA(dataframe, timeperiod=100)
        dataframe['sma_200'] = ta.SMA(dataframe, timeperiod=200)
        
        # === MOMENTUM INDICATORS ===
        dataframe['rsi'] = ta.RSI(dataframe, timeperiod=self.rsi_period.value)
        dataframe['rsi_sma'] = ta.SMA(dataframe['rsi'], timeperiod=10)
        
        # MACD for trend confirmation
        dataframe['macd'], dataframe['macdsignal'], dataframe['macdhist'] = ta.MACD(dataframe)
        
        # === VOLATILITY INDICATORS ===
        dataframe['atr'] = ta.ATR(dataframe, timeperiod=14)
        
        # Bollinger Bands for volatility and mean reversion
        bollinger = qtpylib.bollinger_bands(qtpylib.typical_price(dataframe), 
                                          window=self.bb_period.value, 
                                          stds=self.bb_std.value)
        dataframe['bb_lower'] = bollinger['lower']
        dataframe['bb_middle'] = bollinger['mid']
        dataframe['bb_upper'] = bollinger['upper']
        dataframe['bb_width'] = (dataframe['bb_upper'] - dataframe['bb_lower']) / dataframe['bb_middle']
        dataframe['bb_position'] = (dataframe['close'] - dataframe['bb_lower']) / (dataframe['bb_upper'] - dataframe['bb_lower'])
        
        # === VOLUME INDICATORS ===
        dataframe['volume_sma'] = ta.SMA(dataframe['volume'], timeperiod=20)
        dataframe['volume_ratio'] = dataframe['volume'] / dataframe['volume_sma']
        
        # === MARKET STRUCTURE ===
        # Support and resistance levels
        dataframe['support_20'] = dataframe['low'].rolling(window=20).min()
        dataframe['resistance_20'] = dataframe['high'].rolling(window=20).max()
        
        # Price position relative to recent range
        dataframe['price_position'] = (dataframe['close'] - dataframe['support_20']) / (dataframe['resistance_20'] - dataframe['support_20'])
        
        # Trend strength
        dataframe['trend_strength'] = abs(dataframe['ema_short'] - dataframe['ema_long']) / dataframe['close']
        
        # Market volatility
        dataframe['volatility'] = dataframe['atr'] / dataframe['close']
        
        return dataframe

    def custom_stake_amount(self, pair: str, current_time: datetime, current_rate: float,
                          proposed_stake: float, min_stake: Optional[float], max_stake: float,
                          leverage: float, entry_tag: Optional[str], side: str,
                          **kwargs) -> float:
        """
        Custom position sizing for DCA strategy
        """
        try:
            total_stake = self.wallets.get_total_stake_amount()
            if total_stake <= 0:
                return min_stake or proposed_stake
            
            # Check if this is a DCA order
            is_dca_order = entry_tag and 'dca' in entry_tag.lower()
            
            if is_dca_order:
                # For DCA orders, use calculated DCA size
                return self.calculate_dca_size(pair, entry_tag, total_stake, min_stake, max_stake)
            else:
                # For initial orders, use base position size
                base_stake = total_stake * self.base_position_size.value
                
                # Apply risk limits
                max_allowed = total_stake * self.max_position_size.value
                optimal_stake = min(base_stake, max_allowed, max_stake)
                optimal_stake = max(optimal_stake, min_stake or 0)
                
                logger.info(f"Initial position for {pair}: {optimal_stake:.2f} "
                           f"({(optimal_stake/total_stake)*100:.1f}% of portfolio)")
                
                return optimal_stake
                
        except Exception as e:
            logger.error(f"Error in custom_stake_amount for {pair}: {e}")
            return min_stake or proposed_stake

    def calculate_dca_size(self, pair: str, entry_tag: str, total_stake: float, 
                         min_stake: Optional[float], max_stake: float) -> float:
        """
        Calculate DCA order size based on level and multipliers
        """
        try:
            # Extract DCA level from entry tag
            dca_level = 1  # default
            if 'dca_1' in entry_tag:
                dca_level = 1
                multiplier = self.dca_size_multiplier_1.value
            elif 'dca_2' in entry_tag:
                dca_level = 2
                multiplier = self.dca_size_multiplier_2.value
            elif 'dca_3' in entry_tag:
                dca_level = 3
                multiplier = self.dca_size_multiplier_3.value
            elif 'dca_4' in entry_tag:
                dca_level = 4
                multiplier = self.dca_size_multiplier_4.value
            else:
                multiplier = 1.5  # default multiplier
            
            # Base DCA size
            base_dca_size = total_stake * self.base_position_size.value * multiplier
            
            # Apply limits
            max_allowed = total_stake * 0.15  # Never more than 15% per DCA order
            dca_size = min(base_dca_size, max_allowed, max_stake)
            dca_size = max(dca_size, min_stake or 0)
            
            logger.info(f"DCA Level {dca_level} for {pair}: {dca_size:.2f} "
                       f"(multiplier: {multiplier:.1f})")
            
            return dca_size
            
        except Exception as e:
            logger.error(f"Error calculating DCA size for {pair}: {e}")
            return min_stake or (total_stake * 0.05)

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        DCA entry logic - look for good long-term entry points
        """
        # === MARKET TREND FILTER ===
        if self.use_market_trend_filter.value:
            # Only enter when price is above long-term moving average
            trend_ok = (dataframe['close'] > dataframe['sma_200'])
        else:
            trend_ok = True
        
        # === OVERSOLD CONDITIONS ===
        oversold_conditions = (
            (dataframe['rsi'] < self.rsi_oversold.value) &
            (dataframe['rsi'] > 15) &  # Not extremely oversold (may continue falling)
            (dataframe['bb_position'] < 0.3)  # Near lower bollinger band
        )
        
        # === VOLATILITY FILTER ===
        if self.use_volatility_filter.value:
            # Prefer to enter during normal volatility (not extreme spikes)
            volatility_ok = (
                (dataframe['bb_width'] < 0.15) &  # Not extremely volatile
                (dataframe['volatility'] < 0.08)   # ATR-based volatility check
            )
        else:
            volatility_ok = True
        
        # === VOLUME CONFIRMATION ===
        volume_ok = (
            (dataframe['volume'] > 0) &
            (dataframe['volume_ratio'] > 0.7)  # Reasonable volume
        )
        
        # === SUPPORT LEVEL CHECK ===
        near_support = (
            (dataframe['close'] <= dataframe['support_20'] * 1.05)  # Within 5% of support
        )
        
        # === TREND MOMENTUM CHECK ===
        # Look for potential trend reversal or continuation
        momentum_ok = (
            (dataframe['macd'] > dataframe['macdsignal']) |  # MACD turning positive
            (dataframe['rsi'] > dataframe['rsi'].shift(1))   # RSI improving
        )
        
        # === COMBINED ENTRY CONDITIONS ===
        entry_conditions = (
            trend_ok &
            oversold_conditions &
            volatility_ok &
            volume_ok &
            (near_support | momentum_ok)  # Either near support OR momentum improving
        )
        
        dataframe.loc[entry_conditions, 'enter_long'] = 1
        dataframe.loc[dataframe['enter_long'] == 1, 'enter_tag'] = 'dca_initial'
        
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        DCA exit logic - take profits at key levels
        """
        # === PROFIT TAKING CONDITIONS ===
        overbought_exit = (
            (dataframe['rsi'] > self.rsi_overbought.value) &
            (dataframe['bb_position'] > 0.8)  # Near upper bollinger band
        )
        
        # === TREND REVERSAL CONDITIONS ===
        trend_reversal = (
            (dataframe['ema_short'] < dataframe['ema_long']) &
            (dataframe['macd'] < dataframe['macdsignal']) &
            (dataframe['rsi'] > 50)  # Only exit if not oversold
        )
        
        # === VOLUME SPIKE (possible distribution) ===
        volume_spike = (
            (dataframe['volume_ratio'] > 3.0) &  # Very high volume
            (dataframe['rsi'] > 65)  # And overbought
        )
        
        # === RESISTANCE REJECTION ===
        at_resistance = (
            (dataframe['close'] >= dataframe['resistance_20'] * 0.98) &
            (dataframe['high'] == dataframe['resistance_20'])  # Actually touched resistance
        )
        
        # === COMBINED EXIT CONDITIONS ===
        exit_conditions = (
            overbought_exit |
            (trend_reversal & volume_spike) |
            at_resistance
        )
        
        dataframe.loc[exit_conditions, 'exit_long'] = 1
        
        return dataframe

    def adjust_trade_position(self, trade: Trade, current_time: datetime,
                            current_rate: float, current_profit: float,
                            min_stake: Optional[float], max_stake: float,
                            **kwargs) -> Optional[float]:
        """
        Implement DCA orders based on profit levels
        """
        if not self.dca_enabled.value:
            return None
        
        try:
            # Check timing constraint
            if not self.check_dca_timing(trade, current_time):
                return None
            
            # Check total position size limit
            if not self.check_position_limits(trade):
                return None
            
            # Determine which DCA level to trigger
            dca_level, dca_size = self.get_dca_level_and_size(trade, current_profit)
            
            if dca_level is None:
                return None
            
            # Check if this DCA level was already triggered
            if self.was_dca_level_triggered(trade, dca_level):
                return None
            
            logger.info(f"Triggering DCA Level {dca_level} for {trade.pair}: "
                       f"Profit: {current_profit:.1%}, Size: {dca_size:.2f}")
            
            return dca_size
            
        except Exception as e:
            logger.error(f"Error in adjust_trade_position for {trade.pair}: {e}")
            return None

    def check_dca_timing(self, trade: Trade, current_time: datetime) -> bool:
        """Check if enough time has passed for DCA order"""
        if not trade.orders:
            return True
        
        last_order_time = max(order.order_date for order in trade.orders if order.order_date)
        time_diff = (current_time - last_order_time).total_seconds() / 3600
        
        return time_diff >= self.min_time_between_entries.value

    def check_position_limits(self, trade: Trade) -> bool:
        """Check if position size limits allow for more DCA"""
        try:
            total_stake = self.wallets.get_total_stake_amount()
            if total_stake <= 0:
                return False
            
            # Calculate current position size including pending DCA orders
            current_position_value = trade.stake_amount
            
            # Add pending DCA orders (if any)
            for order in trade.orders:
                if order.status == 'open' and 'dca' in (order.ft_order_tag or ''):
                    current_position_value += order.safe_remaining * order.safe_price
            
            current_allocation = current_position_value / total_stake
            
            # Check against limits
            if current_allocation >= self.max_total_allocation.value:
                logger.info(f"Position allocation limit reached for {trade.pair}: "
                           f"{current_allocation:.1%}")
                return False
            
            return True
            
        except Exception as e:
            logger.error(f"Error checking position limits for {trade.pair}: {e}")
            return False

    def get_dca_level_and_size(self, trade: Trade, current_profit: float) -> tuple:
        """Determine which DCA level should be triggered and its size"""
        try:
            total_stake = self.wallets.get_total_stake_amount()
            
            # Check each DCA level
            if current_profit <= self.dca_level_4.value:
                level = 4
                size = total_stake * self.base_position_size.value * self.dca_size_multiplier_4.value
            elif current_profit <= self.dca_level_3.value:
                level = 3
                size = total_stake * self.base_position_size.value * self.dca_size_multiplier_3.value
            elif current_profit <= self.dca_level_2.value:
                level = 2
                size = total_stake * self.base_position_size.value * self.dca_size_multiplier_2.value
            elif current_profit <= self.dca_level_1.value:
                level = 1
                size = total_stake * self.base_position_size.value * self.dca_size_multiplier_1.value
            else:
                return None, None
            
            # Apply limits
            max_dca_size = total_stake * 0.15  # Max 15% per DCA order
            size = min(size, max_dca_size)
            
            return level, size
            
        except Exception as e:
            logger.error(f"Error determining DCA level for {trade.pair}: {e}")
            return None, None

    def was_dca_level_triggered(self, trade: Trade, level: int) -> bool:
        """Check if a specific DCA level was already triggered"""
        dca_tag = f'dca_{level}'
        return any(dca_tag in (order.ft_order_tag or '') for order in trade.orders)

    def custom_entry_price(self, pair: str, current_time: datetime, proposed_rate: float,
                         entry_tag: Optional[str], side: str, **kwargs) -> float:
        """
        Custom entry price for DCA orders - try to get better fills
        """
        if not entry_tag or 'dca' not in entry_tag.lower():
            return proposed_rate
        
        try:
            # For DCA orders, try to get a slightly better price
            # by placing limit orders below current price
            dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
            if dataframe.empty:
                return proposed_rate
            
            current_candle = dataframe.iloc[-1]
            atr = current_candle.get('atr', proposed_rate * 0.02)
            
            # Place DCA orders 0.5-1% below current price or 0.5*ATR, whichever is smaller
            discount_pct = min(0.01, (atr * 0.5) / proposed_rate)
            better_price = proposed_rate * (1 - discount_pct)
            
            logger.info(f"DCA order price adjustment for {pair}: "
                       f"Market: {proposed_rate:.6f}, "
                       f"DCA: {better_price:.6f} "
                       f"({discount_pct*100:.1f}% discount)")
            
            return better_price
            
        except Exception as e:
            logger.error(f"Error in custom_entry_price for {pair}: {e}")
            return proposed_rate

    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime,
                       current_rate: float, current_profit: float, **kwargs) -> float:
        """
        Dynamic stoploss for DCA strategy
        """
        try:
            # For DCA strategies, be more patient with stoplosses
            # since we're averaging down
            
            # Count DCA orders to adjust stop loss
            dca_orders = len([order for order in trade.orders 
                            if 'dca' in (order.ft_order_tag or '')])
            
            # More DCA orders = more patient stop loss
            dca_adjustment = min(0.04, dca_orders * 0.01)  # Up to 4% more patient
            adjusted_stop = self.stoploss - dca_adjustment
            
            # But don't go below -25% no matter what
            final_stop = max(adjusted_stop, -0.25)
            
            # If we're profitable, use trailing stop logic
            if current_profit > 0.05:  # 5% profit
                # Gradually tighten stop loss as profit increases
                profit_factor = min(current_profit / 0.2, 1.0)  # Scale to 20% profit
                trailing_stop = -0.02 - (0.03 * (1 - profit_factor))  # -2% to -5%
                final_stop = max(final_stop, trailing_stop)
            
            return final_stop
            
        except Exception as e:
            logger.error(f"Error in custom_stoploss for {pair}: {e}")
            return self.stoploss

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float,
                          rate: float, time_in_force: str, current_time: datetime,
                          entry_tag: Optional[str], side: str, **kwargs) -> bool:
        """
        Final confirmation for DCA entries
        """
        try:
            # Always allow DCA orders if they passed previous checks
            if entry_tag and 'dca' in entry_tag.lower():
                return True
            
            # For initial entries, do additional checks
            
            # Check maximum open positions
            open_trades = Trade.get_trades_proxy(is_open=True)
            if len(open_trades) >= 8:  # Max 8 pairs for DCA strategy
                logger.warning(f"Maximum positions reached, rejecting {pair}")
                return False
            
            # Check if we already have a position in this pair
            existing_trade = Trade.get_trades_proxy(is_open=True, pair=pair)
            if existing_trade:
                logger.info(f"Already have position in {pair}, rejecting new entry")
                return False
            
            # Check portfolio allocation
            total_stake = self.wallets.get_total_stake_amount()
            position_value = amount * rate
            allocation = position_value / total_stake if total_stake > 0 else 0
            
            if allocation > self.max_position_size.value:
                logger.warning(f"Position too large for {pair}: {allocation:.1%}")
                return False
            
            return True
            
        except Exception as e:
            logger.error(f"Error in confirm_trade_entry for {pair}: {e}")
            return False

    def leverage(self, pair: str, current_time: datetime, current_rate: float,
                proposed_leverage: float, max_leverage: float, entry_tag: Optional[str],
                side: str, **kwargs) -> float:
        """
        DCA strategy uses no leverage for safety
        """
        return 1.0  # No leverage for DCA strategy