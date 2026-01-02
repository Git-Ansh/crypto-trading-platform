from freqtrade.strategy import IStrategy


class SafeDefaultStrategy(IStrategy):
    """
    Safe fallback strategy that intentionally places no trades.
    Used when the configured strategy file is missing.
    """

    timeframe = "1h"
    minimal_roi = {"0": 0.0}
    stoploss = -0.01
    trailing_stop = False
    use_exit_signal = False

    def populate_indicators(self, dataframe, metadata=None):
        return dataframe

    def populate_entry_trend(self, dataframe, metadata=None):
        dataframe.loc[:, "enter_long"] = False
        return dataframe

    def populate_exit_trend(self, dataframe, metadata=None):
        dataframe.loc[:, "exit_long"] = False
        return dataframe
