# --- Imports ---
import freqtrade.vendor.qtpylib.indicators as qtpylib
import numpy as np
import talib.abstract as ta
from freqtrade.strategy import (IStrategy, IntParameter, DecimalParameter, CategoricalParameter, merge_informative_pair)
from freqtrade.persistence import Trade
from pandas import DataFrame
from functools import reduce
from datetime import datetime, timedelta

# --- Strategy Class ---
class AggressiveSophisticated1m(IStrategy):
    """
    AggressiveSophisticated1m Strategy
    ------------------------------------
    Version: 1.0
    Author: Your Name / AI Assistant

    Description:
    An aggressive strategy for the 1-minute timeframe based on multi-indicator confluence,
    dynamic risk management (ATR trailing stop), regime filtering, and portfolio-aware staking.
    Designed for high concurrency (e.g., max_open_trades = 25).

    Disclaimer: Requires thorough backtesting, hyperparameter optimization, and dry-running.
                Use at your own risk.
    """
    # Strategy interface version - Requires Freqtrade 2023.9 or later
    INTERFACE_VERSION = 3

    # --- Hyperoptable Parameters ---
    # Stoploss Parameters
    atr_period = IntParameter(5, 20, default=14, space="stoploss", optimize=True)
    atr_multiplier = DecimalParameter(1.0, 5.0, default=3.0, decimals=1, space="stoploss", optimize=True)

    # Indicator Parameters (Example - Add more as needed for optimization)
    # MACD
    macd_fast = IntParameter(6, 18, default=12, space="buy", optimize=True)
    macd_slow = IntParameter(18, 36, default=26, space="buy", optimize=True)
    macd_signal = IntParameter(3, 12, default=9, space="buy", optimize=True)
    # Stochastic
    stoch_k = IntParameter(5, 14, default=14, space="buy", optimize=True)
    stoch_d = IntParameter(3, 9, default=3, space="buy", optimize=True)
    # ADX
    adx_period = IntParameter(10, 20, default=14, space="buy", optimize=True)
    # EMAs
    ema_fast_period = IntParameter(5, 20, default=10, space="buy", optimize=True)
    ema_slow_period = IntParameter(20, 70, default=50, space="buy", optimize=True)
    # Bollinger Bands
    bb_period = IntParameter(15, 30, default=20, space="buy", optimize=True)
    bb_stddev = DecimalParameter(1.5, 3.0, default=2.0, decimals=1, space="buy", optimize=True)

    # Regime Filter Thresholds (Example - Optimize these)
    adx_trend_threshold = IntParameter(20, 35, default=25, space="buy", optimize=True)
    adx_range_threshold = IntParameter(15, 25, default=20, space="buy", optimize=True)
    # Add volatility thresholds if needed (e.g., based on BB width or normalized ATR)

    # --- Strategy Configuration ---
    timeframe = '1m'

    # Stoploss configuration
    stoploss = -0.10 # Maximum safety stoploss (e.g., -10%)
    use_custom_stoploss = True # Use the custom_stoploss method below

    # Trailing stoploss configuration (will be managed by custom_stoploss with ATR)
    # These values from config.json might be overridden by custom_stoploss logic if active
    trailing_stop = True
    trailing_stop_positive = 0.005 # Low value, as ATR stop handles the trailing distance
    trailing_stop_positive_offset = 0.015 # Need 1.5% profit before this specific Freqtrade trailing activates (ATR stop might activate sooner/later)
    trailing_only_offset_is_reached = True # Wait for offset before enabling Freqtrade's trailing

    # ROI table - Set high to effectively disable, relying on signals/stops
    minimal_roi = {"0": 1.0}

    # Entry/Exit signal settings
    use_exit_signal = True
    exit_profit_only = False # Allow exits based on signals even at a loss
    ignore_roi_if_entry_signal = False # Consider ROI table if it were lower

    # Optimal timeframe for the strategy.
    optimal_timeframe = '1m'

    # Run "populate_indicators()" only for new candle
    process_only_new_candles = True

    # Optional order book access (set to False unless implementing order book logic)
    order_book_enabled = False

    # Optional order type mapping
    order_types = {
        'entry': 'limit', # Use limit orders to potentially reduce fees/slippage
        'exit': 'limit',
        'stoploss': 'market', # Stoploss must be market order
        'stoploss_on_exchange': False # Manage stoploss within Freqtrade
    }

    # Number of candles the strategy requires before producing valid signals
    # Adjust based on the longest indicator period used (e.g., slow EMA, slow MACD)
    startup_candle_count: int = 70 # Example, ensure it covers ema_slow_period

    # --- Custom Stake Amount ---
    def custom_stake_amount(self, pair: str, current_time: datetime, current_rate: float,
                            proposed_stake: float, min_stake: float, max_stake: float,
                            entry_tag: str | None, side: str, **kwargs) -> float:
        """
        Calculate stake amount dynamically based on the number of open trades.
        This is a sample implementation; customize it based on your risk management rules.
        """
        # Ensure wallets object is available and initialized
        if not hasattr(self, 'wallets') or self.wallets is None:
             # Wallet info might not be available in backtesting without --enable-position-stacking
             # Or during initial startup phases. Return proposed_stake as a fallback.
             # Consider logging a warning here if in live/dry mode.
             # print("Warning: Wallets object not available for custom_stake_amount.")
             return proposed_stake

        open_trades = self.wallets.get_open_trades()
        trade_count = len(open_trades) if open_trades else 0

        # Get max_open_trades from config
        max_trades = self.config.get('max_open_trades', 1) # Default to 1 if not found

        # Define stake reduction tiers (example)
        if max_trades <= 0: # Avoid division by zero
            stake_multiplier = 1.0
        elif trade_count < max_trades / 3:
            stake_multiplier = 1.0 # Full stake for first third
        elif trade_count < max_trades * 2 / 3:
            stake_multiplier = 0.66 # Reduced stake for second third
        else:
            stake_multiplier = 0.33 # Minimum stake for final third

        # Calculate the desired stake based on the multiplier
        # This example scales the 'proposed_stake' which is often based on stake_amount or tradable_balance_ratio
        calculated_stake = proposed_stake * stake_multiplier

        # Ensure the calculated stake respects the minimum and maximum stake limits
        final_stake = max(min_stake, calculated_stake)
        final_stake = min(max_stake, final_stake)

        # Optional: Print statement for debugging stake calculation
        # print(f"Pair: {pair}, Open Trades: {trade_count}/{max_trades}, Stake Multiplier: {stake_multiplier:.2f}, Proposed: {proposed_stake:.2f}, Final: {final_stake:.2f}")

        return final_stake

    # --- Custom Stoploss ---
    def custom_stoploss(self, pair: str, trade: 'Trade', current_time: datetime,
                        current_rate: float, current_profit: float, **kwargs) -> float:
        """
        Custom stoploss logic based on ATR.
        This overrides the static stoploss value if the ATR stop is tighter.
        """
        dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        if dataframe.empty:
            return self.stoploss # Return static stoploss if dataframe is empty

        last_candle = dataframe.iloc[-1].squeeze()

        # Check if ATR value exists and is valid
        atr_col = f'atr_{self.atr_period.value}'
        if atr_col not in last_candle or not np.isfinite(last_candle[atr_col]):
            # Fallback to static stoploss if ATR is not available (e.g., during startup)
            return self.stoploss

        atr_val = last_candle[atr_col]
        atr_multiplier = self.atr_multiplier.value

        # Calculate ATR stop loss price
        if trade.is_short:
            atr_stop_price = last_candle['close'] + atr_val * atr_multiplier # Use close for trailing effect
        else:
            atr_stop_price = last_candle['close'] - atr_val * atr_multiplier # Use close for trailing effect

        # Initial stoploss based on static setting
        initial_stop_price = trade.open_rate * (1 + self.stoploss if trade.is_short else 1 - abs(self.stoploss))

        # Determine the effective stop price:
        # For longs: the highest (least negative) of initial static stop and ATR stop
        # For shorts: the lowest (least positive) of initial static stop and ATR stop
        if trade.is_short:
            stop_price = min(initial_stop_price, atr_stop_price)
        else:
            stop_price = max(initial_stop_price, atr_stop_price)

        # Convert the stop price to a relative stoploss value (required by Freqtrade)
        # Avoid division by zero if open_rate is somehow zero
        if trade.open_rate == 0:
            return self.stoploss

        relative_stop = (stop_price / trade.open_rate) - 1.0

        # Return the calculated relative stoploss
        # Ensure it doesn't exceed the initial definition (e.g., -0.10 for long)
        # This logic prevents the ATR stop from being looser than the initial max stoploss
        if trade.is_short:
             # For shorts, stoploss is positive (e.g., 0.10 for +10%)
             # We want the minimum positive value (tightest stop) but not less than 0 if price moves favorably
             return min(abs(self.stoploss), max(0, relative_stop))
        else:
             # For longs, stoploss is negative (e.g., -0.10 for -10%)
             # We want the maximum negative value (tightest stop) but not greater than 0
             return max(self.stoploss, min(0, relative_stop))


    # --- Populate Indicators ---
    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Calculate all necessary indicators for the strategy.
        """
        # --- Momentum Indicators ---
        # MACD
        dataframe['macd'], dataframe['macdsignal'], dataframe['macdhist'] = ta.MACD(
            dataframe,
            fastperiod=self.macd_fast.value,
            slowperiod=self.macd_slow.value,
            signalperiod=self.macd_signal.value
        )

        # Stochastic
        stoch = ta.STOCH(
            dataframe,
            fastk_period=self.stoch_k.value,
            slowk_period=3, # Standard SlowK smoothing
            slowk_matype=0, # SMA
            slowd_period=self.stoch_d.value,
            slowd_matype=0 # SMA
        )
        dataframe['stoch_k'] = stoch['slowk']
        dataframe['stoch_d'] = stoch['slowd']

        # --- Volatility Indicators ---
        # ATR (for stoploss and potentially volatility regimes)
        dataframe[f'atr_{self.atr_period.value}'] = ta.ATR(dataframe, timeperiod=self.atr_period.value)

        # Bollinger Bands
        bollinger = ta.BBANDS(
            dataframe,
            timeperiod=self.bb_period.value,
            nbdevup=self.bb_stddev.value,
            nbdevdn=self.bb_stddev.value,
            matype=0 # SMA
        )
        dataframe['bb_lowerband'] = bollinger['lowerband']
        dataframe['bb_middleband'] = bollinger['middleband']
        dataframe['bb_upperband'] = bollinger['upperband']
        dataframe['bb_width'] = ((dataframe['bb_upperband'] - dataframe['bb_lowerband']) / dataframe['bb_middleband']) * 100

        # --- Trend Strength Indicators ---
        # ADX
        dataframe['adx'] = ta.ADX(dataframe, timeperiod=self.adx_period.value)
        dataframe['plus_di'] = ta.PLUS_DI(dataframe, timeperiod=self.adx_period.value)
        dataframe['minus_di'] = ta.MINUS_DI(dataframe, timeperiod=self.adx_period.value)

        # --- Trend Context Indicators ---
        # EMAs
        dataframe['ema_fast'] = ta.EMA(dataframe, timeperiod=self.ema_fast_period.value)
        dataframe['ema_slow'] = ta.EMA(dataframe, timeperiod=self.ema_slow_period.value)

        # --- Volume Indicator ---
        # Volume Moving Average
        dataframe['volume_ma'] = ta.SMA(dataframe['volume'], timeperiod=20) # Use a fixed period or make hyperoptable

        # --- Regime Filter Example ---
        # Conditions for regime identification
        is_trending = dataframe['adx'] > self.adx_trend_threshold.value
        is_ranging = dataframe['adx'] < self.adx_range_threshold.value
        # Add volatility conditions if desired (e.g., based on bb_width or normalized ATR)
        # is_high_vol = dataframe['bb_width'] > dataframe['bb_width'].rolling(50).mean() # Example

        # Assign regime: 0: Uncertain, 1: Uptrend, 2: Downtrend, 3: Range
        dataframe['regime'] = 0
        dataframe.loc[is_trending & (dataframe['plus_di'] > dataframe['minus_di']), 'regime'] = 1 # Uptrend
        dataframe.loc[is_trending & (dataframe['minus_di'] > dataframe['plus_di']), 'regime'] = 2 # Downtrend
        dataframe.loc[is_ranging, 'regime'] = 3 # Range

        # --- Signal Preparation ---
        # Initialize columns for entry/exit signals
        dataframe['enter_long'] = 0
        dataframe['exit_long'] = 0
        dataframe['enter_short'] = 0
        dataframe['exit_short'] = 0
        dataframe['exit_tag'] = '' # To track exit reasons

        return dataframe

    # --- Populate Entry Trend ---
    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Define conditions for entering long and short trades based on confluence and regime.
        """
        # --- Long Entry Conditions ---

        # Condition 1: Trend Following Entry (Example: MACD cross + Trend Filter + Volume)
        long_cond_1 = (
            (dataframe['regime'] == 1) & # Uptrend regime
            (qtpylib.crossed_above(dataframe['macd'], dataframe['macdsignal'])) &
            (dataframe['ema_fast'] > dataframe['ema_slow']) & # Price structure confirmation
            (dataframe['volume'] > dataframe['volume_ma'] * 1.1) # Volume confirmation (e.g., 10% above MA)
        )

        # Condition 2: Mean Reversion Entry (Example: Stochastic Oversold in Range + BB touch)
        long_cond_2 = (
            (dataframe['regime'] == 3) & # Ranging regime
            (dataframe['stoch_k'] < 25) & # Stochastic low
            (qtpylib.crossed_above(dataframe['stoch_k'], dataframe['stoch_d'])) & # Stoch bullish cross
            (dataframe['close'] < dataframe['bb_lowerband'] * 1.01) # Close near or below lower BB
        )

        # Combine Long Conditions (use logical OR '|')
        dataframe.loc[
            long_cond_1 | long_cond_2,
            'enter_long'] = 1

        # --- Short Entry Conditions (Symmetrical Examples) ---

        # Condition 1: Trend Following Entry (Short)
        short_cond_1 = (
            (dataframe['regime'] == 2) & # Downtrend regime
            (qtpylib.crossed_below(dataframe['macd'], dataframe['macdsignal'])) &
            (dataframe['ema_fast'] < dataframe['ema_slow']) &
            (dataframe['volume'] > dataframe['volume_ma'] * 1.1)
        )

        # Condition 2: Mean Reversion Entry (Short)
        short_cond_2 = (
            (dataframe['regime'] == 3) & # Ranging regime
            (dataframe['stoch_k'] > 75) & # Stochastic high
            (qtpylib.crossed_below(dataframe['stoch_k'], dataframe['stoch_d'])) & # Stoch bearish cross
            (dataframe['close'] > dataframe['bb_upperband'] * 0.99) # Close near or above upper BB
        )

        # Combine Short Conditions
        dataframe.loc[
            short_cond_1 | short_cond_2,
            'enter_short'] = 1

        return dataframe

    # --- Populate Exit Trend ---
    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Define conditions for exiting long and short trades.
        These signals complement the custom stoploss.
        """
        # --- Long Exit Conditions ---

        # Exit Long Condition 1: Opposite MACD Cross
        exit_long_cond_1 = (
            qtpylib.crossed_below(dataframe['macd'], dataframe['macdsignal'])
        )
        dataframe.loc[exit_long_cond_1, ['exit_long', 'exit_tag']] = (1, 'exit_macd_cross')

        # Exit Long Condition 2: Stochastic Overbought Turn (Example)
        exit_long_cond_2 = (
            (dataframe['stoch_k'] > 80) & # Stochastic high
            (qtpylib.crossed_below(dataframe['stoch_k'], dataframe['stoch_d'])) # Stoch bearish cross
        )
        dataframe.loc[exit_long_cond_2, ['exit_long', 'exit_tag']] = (1, 'exit_stoch_ob')

        # --- Short Exit Conditions (Symmetrical Examples) ---

        # Exit Short Condition 1: Opposite MACD Cross
        exit_short_cond_1 = (
            qtpylib.crossed_above(dataframe['macd'], dataframe['macdsignal'])
        )
        dataframe.loc[exit_short_cond_1, ['exit_short', 'exit_tag']] = (1, 'exit_macd_cross_short')

        # Exit Short Condition 2: Stochastic Oversold Turn (Example)
        exit_short_cond_2 = (
            (dataframe['stoch_k'] < 20) & # Stochastic low
            (qtpylib.crossed_above(dataframe['stoch_k'], dataframe['stoch_d'])) # Stoch bullish cross
        )
        dataframe.loc[exit_short_cond_2, ['exit_short', 'exit_tag']] = (1, 'exit_stoch_os_short')

        return dataframe
