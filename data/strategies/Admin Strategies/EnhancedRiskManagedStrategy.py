# --- Enhanced Risk Management Strategy with DCA and Auto-Rebalancing ---
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


class EnhancedRiskManagedStrategy(IStrategy):
    """
    Enhanced Trading Strategy with Risk Management, DCA, and Auto-Rebalancing
    
    Features:
    - Dynamic position sizing based on portfolio risk
    - Dollar Cost Averaging (DCA) on favorable conditions
    - Portfolio rebalancing across multiple pairs
    - Advanced risk management with trailing stops
    - Volatility-based position sizing
    - Maximum drawdown protection
    """

    # Strategy interface version
    INTERFACE_VERSION = 3

    # Basic strategy configuration
    timeframe = '15m'
    can_short = False
    
    # Advanced ROI with time-based targets
    minimal_roi = {
        "0": 0.20,     # 20% profit target (aggressive but realistic)
        "40": 0.10,    # 10% after 40 minutes
        "80": 0.05,    # 5% after 80 minutes  
        "120": 0.02,   # 2% after 2 hours
        "240": 0.01    # 1% after 4 hours
    }

    # Dynamic stoploss - will be adjusted based on volatility
    stoploss = -0.08  # Base stoploss at -8%
    
    # Trailing stop configuration
    trailing_stop = True
    trailing_stop_positive = 0.02  # Start trailing at +2%
    trailing_stop_positive_offset = 0.04  # Trail by 4%
    trailing_only_offset_is_reached = True

    # Strategy optimization parameters
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = False
    process_only_new_candles = True
    startup_candle_count: int = 50

    # === RISK MANAGEMENT PARAMETERS ===
    
    # Position sizing parameters
    base_stake_percent = DecimalParameter(0.05, 0.25, default=0.10, space="buy", 
                                        optimize=False, load=True)
    max_stake_percent = DecimalParameter(0.15, 0.50, default=0.25, space="buy", 
                                       optimize=False, load=True)
    volatility_factor = DecimalParameter(0.5, 2.0, default=1.0, space="buy", 
                                       optimize=False, load=True)
    
    # Risk management parameters
    max_total_risk = DecimalParameter(0.15, 0.35, default=0.25, space="buy", 
                                    optimize=False, load=True)
    max_drawdown_limit = DecimalParameter(0.10, 0.25, default=0.15, space="buy", 
                                        optimize=False, load=True)
    risk_per_trade = DecimalParameter(0.01, 0.05, default=0.02, space="buy", 
                                    optimize=False, load=True)
    
    # DCA parameters
    enable_dca = BooleanParameter(default=True, space="buy", optimize=False, load=True)
    dca_trigger_percent = DecimalParameter(-0.15, -0.03, default=-0.08, space="buy", 
                                         optimize=False, load=True)
    dca_max_orders = IntParameter(2, 5, default=3, space="buy", optimize=False, load=True)
    dca_multiplier = DecimalParameter(1.2, 2.5, default=1.5, space="buy", 
                                    optimize=False, load=True)
    
    # Portfolio rebalancing parameters
    enable_rebalancing = BooleanParameter(default=True, space="buy", optimize=False, load=True)
    rebalance_threshold = DecimalParameter(0.10, 0.30, default=0.20, space="buy", 
                                         optimize=False, load=True)
    target_allocation = DecimalParameter(0.15, 0.35, default=0.25, space="buy", 
                                       optimize=False, load=True)
    
    # Technical indicator parameters
    ema_fast = IntParameter(8, 15, default=12, space="buy", optimize=True)
    ema_slow = IntParameter(20, 30, default=26, space="buy", optimize=True)
    rsi_period = IntParameter(10, 20, default=14, space="buy", optimize=True)
    rsi_buy = IntParameter(25, 40, default=30, space="buy", optimize=True)
    rsi_sell = IntParameter(60, 80, default=70, space="sell", optimize=True)
    
    # Volatility indicators
    atr_period = IntParameter(10, 20, default=14, space="buy", optimize=False)
    bb_period = IntParameter(15, 25, default=20, space="buy", optimize=False)
    bb_std = DecimalParameter(1.8, 2.5, default=2.0, space="buy", optimize=False)

    def informative_pairs(self):
        """Define additional pairs for portfolio context"""
        return []

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Add technical indicators for strategy and risk management
        """
        # === TREND INDICATORS ===
        dataframe[f'ema_fast'] = ta.EMA(dataframe, timeperiod=self.ema_fast.value)
        dataframe[f'ema_slow'] = ta.EMA(dataframe, timeperiod=self.ema_slow.value)
        dataframe['sma_20'] = ta.SMA(dataframe, timeperiod=20)
        dataframe['sma_50'] = ta.SMA(dataframe, timeperiod=50)
        
        # === MOMENTUM INDICATORS ===
        dataframe['rsi'] = ta.RSI(dataframe, timeperiod=self.rsi_period.value)
        dataframe['macd'], dataframe['macdsignal'], dataframe['macdhist'] = ta.MACD(dataframe)
        dataframe['adx'] = ta.ADX(dataframe, timeperiod=14)
        
        # === VOLATILITY INDICATORS ===
        dataframe['atr'] = ta.ATR(dataframe, timeperiod=self.atr_period.value)
        bollinger = qtpylib.bollinger_bands(qtpylib.typical_price(dataframe), 
                                          window=self.bb_period.value, 
                                          stds=self.bb_std.value)
        dataframe['bb_lower'] = bollinger['lower']
        dataframe['bb_middle'] = bollinger['mid']
        dataframe['bb_upper'] = bollinger['upper']
        dataframe['bb_width'] = (dataframe['bb_upper'] - dataframe['bb_lower']) / dataframe['bb_middle']
        
        # === VOLUME INDICATORS ===
        dataframe['volume_sma'] = ta.SMA(dataframe['volume'], timeperiod=20)
        dataframe['volume_ratio'] = dataframe['volume'] / dataframe['volume_sma']
        
        # === RISK METRICS ===
        # Calculate price volatility (rolling standard deviation)
        dataframe['price_volatility'] = dataframe['close'].rolling(window=20).std() / dataframe['close']
        
        # Calculate support and resistance levels
        dataframe['support'] = dataframe['low'].rolling(window=20).min()
        dataframe['resistance'] = dataframe['high'].rolling(window=20).max()
        
        # Calculate trend strength
        dataframe['trend_strength'] = abs(dataframe['ema_fast'] - dataframe['ema_slow']) / dataframe['close']
        
        return dataframe

    def custom_stake_amount(self, pair: str, current_time: datetime, current_rate: float,
                          proposed_stake: float, min_stake: Optional[float], max_stake: float,
                          leverage: float, entry_tag: Optional[str], side: str,
                          **kwargs) -> float:
        """
        Dynamic position sizing based on risk management and volatility
        """
        try:
            # Get current dataframe for this pair
            dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
            if dataframe.empty:
                return proposed_stake
            
            current_candle = dataframe.iloc[-1]
            
            # === VOLATILITY-BASED SIZING ===
            volatility = current_candle.get('price_volatility', 0.02)
            atr = current_candle.get('atr', current_rate * 0.02)
            
            # Adjust position size based on volatility (lower volatility = larger position)
            volatility_multiplier = max(0.5, min(2.0, 1 / (1 + volatility * 10)))
            
            # === PORTFOLIO RISK ASSESSMENT ===
            total_stake = self.wallets.get_total_stake_amount()
            if total_stake <= 0:
                return min_stake or proposed_stake
            
            # Calculate current portfolio exposure
            open_trades_risk = 0
            for trade in Trade.get_trades_proxy(is_open=True):
                if trade.pair != pair:  # Don't count current trade
                    trade_risk = abs(trade.stake_amount * (trade.stop_loss_pct or 0.08))
                    open_trades_risk += trade_risk
            
            # Maximum allowed risk for this trade
            max_trade_risk = total_stake * self.risk_per_trade.value
            remaining_risk_budget = (total_stake * self.max_total_risk.value) - open_trades_risk
            max_trade_risk = min(max_trade_risk, remaining_risk_budget)
            
            if max_trade_risk <= 0:
                logger.warning(f"No remaining risk budget for {pair}")
                return min_stake or (proposed_stake * 0.1)
            
            # === CALCULATE OPTIMAL POSITION SIZE ===
            # Base position size
            base_stake = total_stake * self.base_stake_percent.value
            
            # Apply volatility adjustment
            adjusted_stake = base_stake * volatility_multiplier * self.volatility_factor.value
            
            # Apply risk-based sizing (position size = risk budget / expected loss per unit)
            stop_distance = atr * 2  # Dynamic stop based on ATR
            risk_based_stake = max_trade_risk / (stop_distance / current_rate)
            
            # Take the minimum of risk-based and volatility-adjusted sizing
            optimal_stake = min(adjusted_stake, risk_based_stake)
            
            # Apply limits
            max_allowed_stake = total_stake * self.max_stake_percent.value
            optimal_stake = max(min_stake or 0, min(optimal_stake, max_allowed_stake, max_stake))
            
            # DCA consideration - reduce initial position if DCA is enabled
            if self.enable_dca.value and entry_tag != "dca":
                optimal_stake *= 0.7  # Reserve 30% for potential DCA orders
            
            logger.info(f"Position sizing for {pair}: "
                       f"Proposed: {proposed_stake:.2f}, "
                       f"Optimal: {optimal_stake:.2f}, "
                       f"Volatility: {volatility:.4f}, "
                       f"Risk Budget: {max_trade_risk:.2f}")
            
            return optimal_stake
            
        except Exception as e:
            logger.error(f"Error in custom_stake_amount for {pair}: {e}")
            return min_stake or (proposed_stake * 0.5)

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Enhanced entry logic with risk management
        """
        # === TREND CONDITIONS ===
        trend_up = (
            (dataframe['ema_fast'] > dataframe['ema_slow']) &
            (dataframe['close'] > dataframe['sma_20']) &
            (dataframe['adx'] > 20)  # Ensure there's a trend
        )
        
        # === MOMENTUM CONDITIONS ===
        momentum_good = (
            (dataframe['rsi'] < self.rsi_buy.value) &
            (dataframe['rsi'] > 25) &  # Not oversold
            (dataframe['macd'] > dataframe['macdsignal'])
        )
        
        # === VOLATILITY CONDITIONS ===
        volatility_acceptable = (
            (dataframe['bb_width'] < 0.15) &  # Not too volatile
            (dataframe['bb_width'] > 0.05)    # But some movement
        )
        
        # === VOLUME CONDITIONS ===
        volume_good = (
            (dataframe['volume'] > 0) &
            (dataframe['volume_ratio'] > 1.2)  # Above average volume
        )
        
        # === SUPPORT/RESISTANCE CONDITIONS ===
        near_support = (
            (dataframe['close'] > dataframe['support'] * 1.01) &  # Above support
            (dataframe['close'] < dataframe['resistance'] * 0.95)  # Below resistance
        )
        
        # === COMBINED ENTRY CONDITIONS ===
        dataframe.loc[
            (
                trend_up &
                momentum_good &
                volatility_acceptable &
                volume_good &
                near_support
            ),
            'enter_long'
        ] = 1
        
        # Add entry tags for tracking
        dataframe.loc[dataframe['enter_long'] == 1, 'enter_tag'] = 'trend_momentum'
        
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Enhanced exit logic with profit protection
        """
        # === TREND REVERSAL CONDITIONS ===
        trend_weakening = (
            (dataframe['ema_fast'] < dataframe['ema_slow']) |
            (dataframe['close'] < dataframe['sma_20']) |
            (dataframe['adx'] < 15)  # Weak trend
        )
        
        # === MOMENTUM CONDITIONS ===
        momentum_weak = (
            (dataframe['rsi'] > self.rsi_sell.value) |
            (dataframe['macd'] < dataframe['macdsignal'])
        )
        
        # === VOLATILITY SPIKE (Risk Management) ===
        volatility_spike = (
            (dataframe['bb_width'] > 0.20) |  # High volatility
            (dataframe['price_volatility'] > 0.08)  # Price becoming unstable
        )
        
        # === VOLUME DECLINE ===
        volume_decline = (
            (dataframe['volume_ratio'] < 0.6)  # Below average volume
        )
        
        # === RESISTANCE REJECTION ===
        at_resistance = (
            (dataframe['close'] >= dataframe['resistance'] * 0.98)
        )
        
        # === COMBINED EXIT CONDITIONS ===
        dataframe.loc[
            (
                (trend_weakening & momentum_weak) |
                volatility_spike |
                (at_resistance & volume_decline)
            ),
            'exit_long'
        ] = 1
        
        return dataframe

    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime,
                       current_rate: float, current_profit: float, **kwargs) -> float:
        """
        Dynamic stoploss based on volatility and time
        """
        try:
            # Get current dataframe
            dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
            if dataframe.empty:
                return self.stoploss
            
            current_candle = dataframe.iloc[-1]
            atr = current_candle.get('atr', current_rate * 0.02)
            
            # === TIME-BASED STOPLOSS ADJUSTMENT ===
            trade_duration = (current_time - trade.open_date_utc).total_seconds() / 3600  # hours
            
            # Tighten stop loss over time for risk management
            time_factor = max(0.5, 1 - (trade_duration / 48))  # Tighten over 48 hours
            
            # === VOLATILITY-BASED STOPLOSS ===
            # Use ATR to set dynamic stop
            atr_multiplier = 2.5  # 2.5x ATR for stop distance
            atr_stop_distance = (atr * atr_multiplier) / current_rate
            volatility_stop = -min(atr_stop_distance, 0.15)  # Cap at 15%
            
            # === PROFIT-BASED STOPLOSS ADJUSTMENT ===
            if current_profit > 0.05:  # If profit > 5%, use trailing stop
                # More aggressive trailing for higher profits
                trailing_factor = max(0.5, 1 - current_profit * 2)
                dynamic_stop = max(volatility_stop * trailing_factor, -0.03)  # Never worse than 3%
            else:
                # Standard stop for break-even or losing trades
                dynamic_stop = volatility_stop * time_factor
            
            # Never make stop loss worse than original
            final_stop = max(dynamic_stop, self.stoploss)
            
            if current_profit > 0.02:  # Log only for profitable trades
                logger.info(f"Dynamic stop for {pair}: Profit: {current_profit:.1%}, "
                           f"Stop: {final_stop:.1%}, ATR: {atr:.6f}")
            
            return final_stop
            
        except Exception as e:
            logger.error(f"Error in custom_stoploss for {pair}: {e}")
            return self.stoploss

    def check_dca_conditions(self, pair: str, trade: Trade, current_rate: float) -> bool:
        """
        Check if DCA (Dollar Cost Averaging) order should be placed
        """
        if not self.enable_dca.value:
            return False
        
        # Check if we haven't reached max DCA orders
        dca_orders = len([order for order in trade.orders if 'dca' in (order.ft_order_tag or '')])
        if dca_orders >= self.dca_max_orders.value:
            return False
        
        # Check if price has dropped enough to trigger DCA
        current_profit = trade.calc_profit_ratio(current_rate)
        if current_profit > self.dca_trigger_percent.value:
            return False
        
        # Check if enough time has passed since last DCA order
        if trade.orders:
            last_order_time = max(order.order_date for order in trade.orders)
            time_since_last = (datetime.utcnow() - last_order_time).total_seconds() / 3600
            if time_since_last < 2:  # Wait at least 2 hours between DCA orders
                return False
        
        return True

    def adjust_trade_position(self, trade: Trade, current_time: datetime,
                            current_rate: float, current_profit: float,
                            min_stake: Optional[float], max_stake: float,
                            **kwargs) -> Optional[float]:
        """
        Implement DCA strategy by adjusting trade positions
        """
        if not self.check_dca_conditions(trade.pair, trade, current_rate):
            return None
        
        try:
            # Calculate DCA order size (scaled by multiplier)
            dca_orders_count = len([order for order in trade.orders if 'dca' in (order.ft_order_tag or '')])
            dca_multiplier = self.dca_multiplier.value ** dca_orders_count
            
            # Base DCA size (percentage of original trade)
            original_stake = trade.stake_amount
            dca_stake = original_stake * 0.3 * dca_multiplier  # Start with 30% of original
            
            # Apply risk limits
            total_stake = self.wallets.get_total_stake_amount()
            max_dca_stake = total_stake * 0.05  # Never more than 5% of portfolio per DCA
            dca_stake = min(dca_stake, max_dca_stake, max_stake)
            
            if dca_stake < (min_stake or 0):
                return None
            
            logger.info(f"DCA order for {trade.pair}: Size: {dca_stake:.2f}, "
                       f"Profit: {current_profit:.1%}, "
                       f"DCA Count: {dca_orders_count}")
            
            return dca_stake
            
        except Exception as e:
            logger.error(f"Error in adjust_trade_position for {trade.pair}: {e}")
            return None

    def leverage(self, pair: str, current_time: datetime, current_rate: float,
                proposed_leverage: float, max_leverage: float, entry_tag: Optional[str],
                side: str, **kwargs) -> float:
        """
        Dynamic leverage based on risk management
        """
        # Conservative approach - use minimal leverage for risk management
        if self.max_total_risk.value > 0.20:  # High risk tolerance
            return min(2.0, max_leverage)  # Max 2x leverage
        else:  # Conservative risk tolerance
            return 1.0  # No leverage

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float,
                          rate: float, time_in_force: str, current_time: datetime,
                          entry_tag: Optional[str], side: str, **kwargs) -> bool:
        """
        Final risk check before entering a trade
        """
        try:
            # === PORTFOLIO RISK CHECK ===
            total_stake = self.wallets.get_total_stake_amount()
            if total_stake <= 0:
                return False
            
            # Check total open positions
            open_trades = Trade.get_trades_proxy(is_open=True)
            if len(open_trades) >= 10:  # Max 10 open positions
                logger.warning(f"Maximum open positions reached, rejecting {pair}")
                return False
            
            # Check total portfolio risk
            total_risk = sum(abs(trade.stake_amount * (trade.stop_loss_pct or 0.08)) 
                           for trade in open_trades)
            trade_risk = amount * rate * 0.08  # Assume 8% risk per trade
            
            if (total_risk + trade_risk) > (total_stake * self.max_total_risk.value):
                logger.warning(f"Portfolio risk limit exceeded, rejecting {pair}")
                return False
            
            # === MARKET CONDITION CHECK ===
            dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
            if dataframe.empty:
                return False
            
            current_candle = dataframe.iloc[-1]
            
            # Don't trade in extremely volatile conditions
            if current_candle.get('bb_width', 0) > 0.25:
                logger.warning(f"High volatility detected, rejecting {pair}")
                return False
            
            # Don't trade with very low volume
            if current_candle.get('volume_ratio', 0) < 0.5:
                logger.warning(f"Low volume detected, rejecting {pair}")
                return False
            
            return True
            
        except Exception as e:
            logger.error(f"Error in confirm_trade_entry for {pair}: {e}")
            return False

    def confirm_trade_exit(self, pair: str, trade: Trade, order_type: str, amount: float,
                         rate: float, time_in_force: str, exit_reason: str,
                         current_time: datetime, **kwargs) -> bool:
        """
        Confirm trade exit with additional checks
        """
        try:
            # Always allow emergency exits
            if exit_reason in ['stop_loss', 'stoploss_on_exchange', 'emergency_exit']:
                return True
            
            # For profit-taking exits, ensure we're not exiting too early
            if exit_reason in ['roi', 'exit_signal'] and trade.calc_profit_ratio(rate) < 0.02:
                # Don't exit profitable trades too early unless there's a strong signal
                dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
                if not dataframe.empty:
                    current_candle = dataframe.iloc[-1]
                    # Allow exit if RSI is very high or volatility is spiking
                    if (current_candle.get('rsi', 50) > 80 or 
                        current_candle.get('bb_width', 0) > 0.20):
                        return True
                    else:
                        logger.info(f"Delaying exit for {pair} - not enough profit yet")
                        return False
            
            return True
            
        except Exception as e:
            logger.error(f"Error in confirm_trade_exit for {pair}: {e}")
            return True  # Default to allowing exit on error

    def custom_stake_amount(self, pair: str, current_time: datetime, current_rate: float,
                           proposed_stake: float, min_stake: Optional[float], max_stake: float,
                           leverage: float, entry_tag: Optional[str], side: str,
                           **kwargs) -> float:
        """
        Universal Risk Management Integration
        
        This method integrates with the universal risk management system
        to apply dynamic position sizing based on risk configuration.
        """
        try:
            import os
            import json
            from pathlib import Path
            
            # Get bot instance info from environment or config
            bot_instance_id = os.environ.get('BOT_INSTANCE_ID', 'unknown')
            user_id = os.environ.get('USER_ID', 'unknown')
            
            # Path to universal risk management files
            if bot_instance_id != 'unknown' and user_id != 'unknown':
                base_path = Path(f"/home/ubuntu/Workspace/crypto-trading-platform/data/freqtrade-instances/{user_id}/{bot_instance_id}")
                settings_path = base_path / "universal-settings.json"
                risk_config_path = base_path / "risk-config.json"
                
                # Check if universal risk management is enabled
                if settings_path.exists() and risk_config_path.exists():
                    with open(settings_path, 'r') as f:
                        settings = json.load(f)
                    
                    if settings.get('enabled', False):
                        with open(risk_config_path, 'r') as f:
                            risk_config = json.load(f)
                        
                        # Get current account balance
                        account_balance = self.dp.get_balance_base()
                        if account_balance and account_balance > 0:
                            # Calculate position size based on risk config
                            risk_per_trade = risk_config.get('riskPerTrade', 0.01)
                            position_size = account_balance * risk_per_trade
                            
                            # Apply pair-specific multipliers if configured
                            pair_multipliers = risk_config.get('pairMultipliers', {})
                            multiplier = pair_multipliers.get(pair, 1.0)
                            position_size *= multiplier
                            
                            # Ensure within min/max limits
                            if min_stake:
                                position_size = max(position_size, min_stake)
                            position_size = min(position_size, max_stake)
                            
                            logger.info(f"🎯 Universal Risk Management: {pair} position size ${position_size:.2f} "
                                      f"(Risk: {risk_per_trade*100:.1f}%, Multiplier: {multiplier})")
                            
                            return position_size
            
            # Fallback to proposed stake if universal risk management not available
            logger.info(f"⚠️ Using proposed stake ${proposed_stake:.2f} for {pair} (Universal RM not configured)")
            return proposed_stake
            
        except Exception as e:
            logger.error(f"Error in custom_stake_amount for {pair}: {e}")
            return proposed_stake  # Fallback to proposed stake on error