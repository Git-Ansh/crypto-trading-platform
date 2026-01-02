
import talib.abstract as ta
from pandas import DataFrame # Ensure DataFrame is imported
from freqtrade.strategy import IStrategy, IntParameter
import freqtrade.vendor.qtpylib.indicators as qtpylib
class DefaultStrategy(IStrategy):
    INTERFACE_VERSION = 3; minimal_roi = {"0": 0.01}; stoploss = -0.10; timeframe = '5m'
    process_only_new_candles = True; startup_candle_count: int = 20; use_exit_signal = True; exit_profit_only = False
    buy_rsi = IntParameter(10, 40, default=30, space='buy'); sell_rsi = IntParameter(60, 90, default=70, space='sell')
    def populate_indicators(self, df: DataFrame, md: dict) -> DataFrame: df['rsi'] = ta.RSI(df); return df
    def populate_entry_trend(self, df: DataFrame, md: dict) -> DataFrame: df.loc[(qtpylib.crossed_below(df['rsi'], self.buy_rsi.value)), 'enter_long'] = 1; return df
    def populate_exit_trend(self, df: DataFrame, md: dict) -> DataFrame: df.loc[(qtpylib.crossed_above(df['rsi'], self.sell_rsi.value)), 'exit_long'] = 1; return df
