# --- High-Frequency 1m Scalping Strategy for Freqtrade ---
# This strategy class is written for Freqtrade's latest version (interface V3).
# It implements a high-frequency scalping approach with aggressive settings.
# Indicators: EMA (trend), Bollinger Bands (volatility), Stochastic & RSI (momentum), ADX (trend strength), Volume MA.
# Entry logic: Buy on oversold bounce in uptrend with confirmations (stoch, RSI, etc).
# Exit logic: Take quick profit at ROI target or when momentum fades (overbought or price rebound to resistance).
# Risk management: initial stop-loss, dynamic trailing stop, and ROI targets to secure profits.
from freqtrade.strategy import IStrategy, stoploss_from_open
from pandas import DataFrame
import talib.abstract as ta
import freqtrade.vendor.qtpylib.indicators as qtpylib

class HighFrequencyScalp1m(IStrategy):
    """
    HighFrequencyScalp1m: A high-frequency 1-minute scalping strategy for Freqtrade.
    Focus: Many small wins via quick momentum trades. Aggressive risk settings.
    """
    # Interface version (for Freqtrade v2023+ with enter/exit signals)
    INTERFACE_VERSION = 3

    # Optimal timeframe for this strategy
    timeframe = '1m'
    # We only need to process new candle data (avoid intra-candle duplicates)
    process_only_new_candles = True
    # Allow the strategy to open a high number of concurrent trades
    max_open_trades = -1  # No limit on number of open trades (manage risk via stake per trade)

    # Enable custom stoploss logic
    use_custom_stoploss = True

    # ROI: Take profit as soon as target is reached. 
    # Define minimal ROI tiers: e.g., 1% from the start, and after 30 minutes, no profit requirement (could exit at break-even).
    minimal_roi = {
        "0": 0.01,   # 1% profit target from trade open until ...
        "30": 0      # After 30 minutes, if still open, accept any non-negative profit (exit if it comes back to 0%).
    }

    # Initial stop-loss (percentage of the trade entry price). 
    # This is a safety net; the custom stoploss will modify it dynamically.
    stoploss = -0.05  # -5% initial stop-loss (trade will be stopped if price drops 5% from buy price, unless custom stop updates it)

    # Trailing stop (we implement our own in custom_stoploss, so built-in trailing is disabled to avoid conflicts)
    trailing_stop = False

    # (Optional) If we wanted to use built-in trailing stop instead of custom logic:
    # trailing_stop = True
    # trailing_stop_positive = 0.005  # 0.5% trailing (once profit > trailing offset)
    # trailing_stop_positive_offset = 0.01  # 1% profit before trailing is activated
    # trailing_only_offset_is_reached = True  # Start trailing only after reaching the offset

    # Entry/exit settings
    # We will use the new enter_long/exit_long signals (and not use shorting in this strategy).
    can_short = False
    # We use sell signals (exit signals) along with ROI/stoploss
    use_sell_signal = True
    sell_profit_only = False  # allow selling at loss if exit signal triggers (stoploss will handle major losses anyway)
    ignore_roi_if_buy_signal = False  # do not ignore ROI; ROI takes priority when reached.

    # Strategy specific variables (like indicator thresholds)
    # Define as class variables if we want to easily tweak or hyperopt.
    RSI_OVERSOLD = 30
    RSI_OVERBOUGHT = 70
    STOCH_OVERSOLD = 20
    STOCH_OVERBOUGHT = 80
    ADX_THRESHOLD = 25

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Calculate all required indicators for the strategy. 
        This method is called for each candle (row in dataframe) and should add indicator columns to the dataframe.
        """
        # Exponential Moving Averages (EMA) for trend direction
        dataframe['ema_fast'] = ta.EMA(dataframe, timeperiod=50)   # Fast EMA (e.g. 50-period)
        dataframe['ema_slow'] = ta.EMA(dataframe, timeperiod=200)  # Slow EMA (e.g. 200-period)
        # EMA rationale: EMA reacts faster to price changes than SMA, ideal for short-term trend detection&#8203;:contentReference[oaicite:18]{index=18}.

        # Bollinger Bands for volatility and mean reversion context
        bollinger = qtpylib.bollinger_bands(dataframe['close'], window=20, stds=2)
        dataframe['bb_upper'] = bollinger['upper']
        dataframe['bb_middle'] = bollinger['mid']
        dataframe['bb_lower'] = bollinger['lower']
        # Bollinger bands usage: Price touching or below the lower band indicates an oversold condition (far from mean)&#8203;:contentReference[oaicite:19]{index=19}.

        # Stochastic Oscillator (fast)
        # Using a 14-period stochastic (default) or shorter 5-period for faster signals.
        stoch_fast = ta.STOCHF(dataframe, fastk_period=5, fastd_period=3, fastd_matype=0)
        dataframe['fastk'] = stoch_fast['fastk']  # %K line
        dataframe['fastd'] = stoch_fast['fastd']  # %D line (signal line)
        # Stoch: Values <20 indicate oversold, >80 overbought. We'll look for %K crossing above %D as entry signal from oversold levels.

        # Relative Strength Index (RSI)
        dataframe['rsi'] = ta.RSI(dataframe, timeperiod=14)
        # RSI: Classic momentum oscillator, <30 oversold, >70 overbought&#8203;:contentReference[oaicite:20]{index=20}.

        # Average Directional Index (ADX) and directional indicators
        dataframe['adx'] = ta.ADX(dataframe, timeperiod=14)
        dataframe['di_plus'] = ta.PLUS_DI(dataframe, timeperiod=14)
        dataframe['di_minus'] = ta.MINUS_DI(dataframe, timeperiod=14)
        # ADX indicates trend strength. We use ADX > 25 as a threshold for a strong trend&#8203;:contentReference[oaicite:21]{index=21}.
        # di_plus/di_minus indicate trend direction (di_plus > di_minus means uptrend, vice versa).

        # Volume indicators
        # Compute a moving average of volume to gauge relative volume
        dataframe['vol_ma'] = ta.SMA(dataframe, timeperiod=30, price='volume')
        # We'll use this to filter out extremely low volume candles.

        # Parabolic SAR (Stop and Reverse) for potential stop-loss reference (optional)
        dataframe['sar'] = ta.SAR(dataframe, acceleration=0.02, maximum=0.2)
        # SAR can indicate trend direction and potential reversal points for trailing stop usage.

        # Note: We ensure enough historical candles (lookback) for these indicators via startup_candle_count if needed.
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Define conditions for entering a long trade. (We set 'enter_long' to 1 when all buy conditions are met.)
        """
        # First, prepare a baseline condition for trend: we prefer long trades in uptrend or at least not in strong downtrend.
        uptrend = (dataframe['ema_fast'] > dataframe['ema_slow'])  # fast EMA above slow EMA indicates uptrend
        # Alternatively, we could use DI lines: uptrend = (dataframe['di_plus'] > dataframe['di_minus'])

        # Oversold conditions: Stochastic %K and %D are below oversold threshold
        stoch_oversold = (dataframe['fastk'] < self.STOCH_OVERSOLD) & (dataframe['fastd'] < self.STOCH_OVERSOLD)
        # Stoch cross: %K crossing above %D (bullish cross). Using qtpylib to detect crossing event.
        stoch_cross_up = qtpylib.crossed_above(dataframe['fastk'], dataframe['fastd'])
        # RSI oversold condition
        rsi_oversold = (dataframe['rsi'] < self.RSI_OVERSOLD)

        # Price near Bollinger lower band (optional additional condition for deep pullback)
        price_very_low = (dataframe['close'] < dataframe['bb_lower'])
        # Or use price vs EMA: as in original scalp strategy, open < ema_low (here we could approximate with close < lower band or a similar concept).

        # ADX strong trend condition (to ensure there's momentum in market)
        adx_trending = (dataframe['adx'] > self.ADX_THRESHOLD)

        # Volume condition: current volume > 50% of average volume (to avoid extremely low volume times)
        vol_ok = (dataframe['volume'] > (0.5 * dataframe['vol_ma']))

        # Combine all entry conditions for a long
        dataframe.loc[
            uptrend &                      # preferably in an uptrend
            adx_trending &                # market has some trend strength
            vol_ok &                      # not in ultra-low volume condition
            stoch_oversold &              # stochastic in oversold region
            rsi_oversold &                # RSI confirms oversold
            stoch_cross_up &              # stochastic %K crossed above %D (momentum turning up)
            price_very_low                # price is at/below lower Bollinger band (very oversold relative to recent range)
            ,
            'enter_long'] = 1

        # Note: We require multiple confirmations (trend, momentum, volatility, volume) before entering&#8203;:contentReference[oaicite:22]{index=22}.
        # This reduces false signals inherent in noisy 1m data.
        # If market is downtrending (EMA_fast < EMA_slow), the strategy by default won't enter long.
        # (One could allow counter-trend scalps by removing the uptrend condition, but that increases risk.)

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Define conditions for exiting a long trade (before stoploss or ROI hit). 
        We set 'exit_long' to 1 when any sell conditions are met.
        """
        # Exit on stochastic overbought (sell when momentum likely exhausted)
        stoch_overbought = ((dataframe['fastk'] > self.STOCH_OVERBOUGHT) | (dataframe['fastd'] > self.STOCH_OVERBOUGHT))
        stoch_cross_down = qtpylib.crossed_above(dataframe['fastk'], self.STOCH_OVERBOUGHT) | qtpylib.crossed_above(dataframe['fastd'], self.STOCH_OVERBOUGHT)
        # We use crossed_above(..., 80) to catch the moment when Stoch enters overbought territory.

        # Exit on RSI overbought
        rsi_overbought = qtpylib.crossed_above(dataframe['rsi'], self.RSI_OVERBOUGHT)
        # Alternatively, we could simply use (dataframe['rsi'] > 70) but crossed_above ensures we trigger once when it crosses the threshold.

        # Exit if price has rebounded to a recent high level.
        # We use a short EMA of highs as a proxy for "recent high". (Alternatively, upper BB or a fixed profit target is handled by ROI.)
        dataframe['ema_high_5'] = ta.EMA(dataframe, timeperiod=5, price='high')
        price_near_peak = (dataframe['close'] >= dataframe['ema_high_5'])
        # Rationale: if current price is at or above the EMA of recent highs, it's likely a local peak – good point to take profit.

        dataframe.loc[
            # Any of the exit conditions triggers a sell signal:
            (
                price_near_peak  # price reached a local high level
            ) | (
                stoch_cross_down  # Stochastic entered overbought zone (momentum peak)
            ) | (
                rsi_overbought   # RSI crossed into overbought (>70)
            ),
            'exit_long'] = 1

        # Note: We combine multiple exit triggers with OR. If any triggers, we mark exit.
        # Additionally, ROI and stoploss (including trailing via custom_stoploss) will manage exits regardless of these signals.
        # The 'exit_long' signals mainly ensure we take profit early if momentum indicators show overbought or if price hit a likely resistance.
        return dataframe

    def custom_stoploss(self, pair: str, trade, current_time, current_rate, current_profit, **kwargs) -> float:
        """
        Custom dynamic stoploss logic. This is called continuously (for open trades) to allow adjusting the stoploss.
        It should return a new stoploss (as a negative % of current price) or `None` if no change.
        """
        # If trade is not yet in profit or just slightly (below 1%), keep the initial stoploss (don't tighten yet).
        if current_profit < 0.01:  # less than +1% profit
            return 1  # 1 (100%) is a placeholder: it's above any realistic stop, so it effectively leaves the stoploss at initial value.
            # (Returning a value larger (less negative) than the initial stoploss will be ignored, thus keeping initial stop.)

        # Once profit >= 1%, we can start trailing the stop loss upward to secure profits.
        # Simple trailing logic: set stoploss at half of the current profit (so if profit is 4%, stop at 2% profit).
        desired_stop = current_profit / 2  # e.g., at +2%, keep +1% stop; at +1%, keep +0.5% stop.

        # Ensure the stoploss is not below a minimum profitable level and not above a maximum lock (to avoid trailing too aggressively).
        min_stop = 0.0025  # Minimum 0.25% profit lock once trailing starts.
        max_stop = 0.05    # Maximum stop level at 5% (we won't trail beyond locking in 5% profit).
        new_stop = max(min(desired_stop, max_stop), min_stop)

        # Additionally, one could incorporate time or indicator-based stop adjustments:
        # e.g., if trade has been open long or momentum fades (RSI diverges), tighten stop more aggressively.
        # For simplicity, we use profit-based trailing only here.

        return new_stop  # Return stoploss as positive fraction of current price (Freqtrade interprets this as new stoploss level relative to current price).

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float, time, **kwargs) -> bool:
        """
        Optional confirmation step before actually issuing a buy order.
        This allows us to check current order book or other conditions right at execution time.
        Return True to proceed with order, False to cancel.
        """
        # Check order book for the pair (depth 1 = top of book)
        ob = self.dp.orderbook(pair, 1)
        if ob:
            best_ask = ob['asks'][0][0]  # lowest sell price
            best_bid = ob['bids'][0][0]  # highest buy price
            spread = (best_ask - best_bid) / best_bid if best_bid > 0 else 0

            # If spread is too large, it means low liquidity or high slippage risk – skip trade
            if spread > 0.003:  # e.g., >0.3% spread
                # We avoid entering because the instant buy would be at a significantly higher price than last trade price.
                return False

            # We could also check depth: e.g., volume at best ask to ensure our order won't move price too much.
            # If our amount is large relative to orderbook depth, that could be an issue.
            # For brevity, we assume amount is small relative to market depth in this strategy.

        # If no orderbook data or spread is fine, allow the trade.
        return True

    # (Optional) custom_exit or other callbacks can be implemented if needed (e.g., for time-based exit).
    # In this strategy, exits are handled by exit signals, ROI, and stoploss/trailing, so no custom_exit is defined.
