# --- Do not remove these libs ---
from freqtrade.strategy import IStrategy
from pandas import DataFrame
import talib.abstract as ta
import freqtrade.vendor.qtpylib.indicators as qtpylib

# --------------------------------

class EmaRsiStrategy(IStrategy):
    """
    Basic EMA Crossover Strategy with RSI Filter

    Strategy Description:
    - Buys when Fast EMA crosses above Slow EMA and RSI is below a threshold (e.g., 60).
    - Sells when Fast EMA crosses below Slow EMA.
    - Uses a static stoploss and a minimal ROI table.

    Note: This is a sample strategy template. The parameters below are EXAMPLE defaults
    and require hyperparameter optimization for any real-world trading.

    You should optimize these parameters for your specific pair(s) and timeframe
    using `freqtrade hyperopt --strategy EmaRsiStrategy...`
    """

    # Strategy interface version - Required
    INTERFACE_VERSION = 3

    # Timeframe selection - Chosen based on balance between noise filtering and responsiveness
    timeframe = '15m'

    # Minimal ROI settings - Profit taking based on time
    minimal_roi = {
        "0": 0.15,   # Target 15% profit at any time (immediately if possible)
        "60": 0.05,  # Target 5% profit after 60 minutes
        "120": 0.02  # Target 2% profit after 120 minutes
    }

    # Stoploss configuration - Static stoploss definition
    stoploss = -0.10  # Static stoploss at -10%

    # Trailing stoploss (disabled by default, uncomment to enable)
    # trailing_stop = False
    # trailing_stop_positive = 0.01
    # trailing_stop_positive_offset = 0.02
    # trailing_only_offset_is_reached = False

    # Optimal ticker interval for the strategy structure
    ticker_interval = timeframe

    # Run "populate_indicators()" only for new candle notifications
    process_only_new_candles = True

    # These values can be overridden in the config.
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False

    # --- Strategy Parameter Definition ---
    # Define strategy parameters for optimization
    buy_params = {
        "buy_rsi_threshold": 60,  # Default RSI threshold for buy signal confirmation
    }

    sell_params = {
        # No sell parameters defined for this simple exit logic
    }

    # --- Indicator Definition ---
    ema_fast_period = 10  # Fast EMA period
    ema_slow_period = 21  # Slow EMA period
    rsi_period = 14       # RSI period

    def informative_pairs(self):
        """
        Define additional, informative data pairs to be cached from the exchange.
        These pairs can be used to enrich the main pair's dataframe.
        """
        return []

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Adds several different TA indicators to the given DataFrame.

        Args:
            dataframe (DataFrame): Dataframe with data from the exchange.
            metadata (dict): Additional information, like the currently traded pair.

        Returns:
            DataFrame: DataFrame with calculated indicators.
        """
        # Calculate EMA Fast
        dataframe[f'ema_{self.ema_fast_period}'] = ta.EMA(dataframe, timeperiod=self.ema_fast_period)
        # Calculate EMA Slow
        dataframe[f'ema_{self.ema_slow_period}'] = ta.EMA(dataframe, timeperiod=self.ema_slow_period)

        # Calculate RSI
        dataframe['rsi'] = ta.RSI(dataframe, timeperiod=self.rsi_period)

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Based on TA indicators, populates the 'enter_long' column with 1 (entry) or 0 (no entry).

        Args:
            dataframe (DataFrame): DataFrame with calculated indicators.
            metadata (dict): Additional information, like the currently traded pair.

        Returns:
            DataFrame: DataFrame with 'enter_long' column.
        """
        # Retrieve the RSI threshold from buy_params
        buy_rsi_threshold = self.buy_params['buy_rsi_threshold']

        # Define conditions for entry
        dataframe.loc[
            (
                (dataframe[f'ema_{self.ema_fast_period}'] > dataframe[f'ema_{self.ema_slow_period}']) &
                (dataframe['rsi'] < buy_rsi_threshold) &
                (dataframe['volume'] > 0)
            ),
            'enter_long'
        ] = 1

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Based on TA indicators, populates the 'exit_long' column with 1 (exit) or 0 (no exit).

        Args:
            dataframe (DataFrame): DataFrame with calculated indicators.
            metadata (dict): Additional information, like the currently traded pair.

        Returns:
            DataFrame: DataFrame with 'exit_long' column.
        """
        # Define conditions for exit
        dataframe.loc[
            (
                (dataframe[f'ema_{self.ema_fast_period}'] < dataframe[f'ema_{self.ema_slow_period}']) &
                (dataframe['volume'] > 0)
            ),
            'exit_long'
        ] = 1

        return dataframe
