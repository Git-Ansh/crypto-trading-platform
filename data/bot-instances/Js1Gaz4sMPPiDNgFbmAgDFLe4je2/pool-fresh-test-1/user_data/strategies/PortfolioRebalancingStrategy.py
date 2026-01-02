# --- Portfolio Rebalancing Strategy ---
from freqtrade.strategy import IStrategy, DecimalParameter, IntParameter, BooleanParameter
from pandas import DataFrame
import talib.abstract as ta
import freqtrade.vendor.qtpylib.indicators as qtpylib
import logging
from typing import Optional, Dict
from freqtrade.persistence import Trade
from datetime import datetime, timedelta
import numpy as np

logger = logging.getLogger(__name__)


class PortfolioRebalancingStrategy(IStrategy):
    """
    Portfolio Rebalancing Strategy with Dynamic Allocation
    
    This strategy focuses on:
    - Maintaining target allocation percentages across multiple assets
    - Rebalancing when allocations drift beyond thresholds
    - Dynamic adjustment based on market conditions
    - Risk-parity approach with volatility consideration
    - Momentum and mean-reversion balancing
    """

    # Strategy interface version
    INTERFACE_VERSION = 3

    # Basic configuration
    timeframe = '4h'  # Longer timeframe for rebalancing decisions
    can_short = False
    
    # ROI configuration - be patient with rebalancing
    minimal_roi = {
        "0": 0.25,     # 25% profit target
        "240": 0.15,   # 15% after 4 hours
        "480": 0.10,   # 10% after 8 hours
        "960": 0.05,   # 5% after 16 hours
        "1920": 0.02   # 2% after 32 hours
    }

    # Conservative stoploss for portfolio approach
    stoploss = -0.15  # -15% stoploss
    
    # No trailing stop initially - let rebalancing handle risk
    trailing_stop = False

    # Strategy configuration
    use_exit_signal = True
    exit_profit_only = False
    ignore_roi_if_entry_signal = True  # Don't exit during rebalancing
    process_only_new_candles = True
    startup_candle_count: int = 200

    # === PORTFOLIO ALLOCATION PARAMETERS ===
    
    # Target allocations (should add up to 1.0 or less)
    target_btc_allocation = DecimalParameter(0.30, 0.50, default=0.40, space="buy", optimize=False, load=True)
    target_eth_allocation = DecimalParameter(0.20, 0.35, default=0.25, space="buy", optimize=False, load=True)
    target_alt_allocation = DecimalParameter(0.15, 0.30, default=0.20, space="buy", optimize=False, load=True)
    target_stable_allocation = DecimalParameter(0.05, 0.20, default=0.10, space="buy", optimize=False, load=True)
    target_other_allocation = DecimalParameter(0.00, 0.10, default=0.05, space="buy", optimize=False, load=True)
    
    # Rebalancing triggers
    rebalance_threshold = DecimalParameter(0.10, 0.30, default=0.15, space="buy", optimize=False, load=True)
    rebalance_frequency_hours = IntParameter(12, 72, default=24, space="buy", optimize=False, load=True)
    min_rebalance_amount = DecimalParameter(50, 200, default=100, space="buy", optimize=False, load=True)
    
    # Risk parameters
    max_position_size = DecimalParameter(0.15, 0.35, default=0.25, space="buy", optimize=False, load=True)
    min_position_size = DecimalParameter(0.02, 0.08, default=0.05, space="buy", optimize=False, load=True)
    volatility_adjustment = BooleanParameter(default=True, space="buy", optimize=False, load=True)
    momentum_adjustment = BooleanParameter(default=True, space="buy", optimize=False, load=True)
    
    # Market condition filters
    use_trend_filter = BooleanParameter(default=True, space="buy", optimize=False, load=True)
    use_volatility_filter = BooleanParameter(default=True, space="buy", optimize=False, load=True)
    max_portfolio_volatility = DecimalParameter(0.15, 0.40, default=0.25, space="buy", optimize=False, load=True)
    
    # Technical indicators
    trend_ema_period = IntParameter(50, 100, default=75, space="buy", optimize=False)
    momentum_period = IntParameter(10, 25, default=14, space="buy", optimize=False)
    volatility_period = IntParameter(15, 30, default=20, space="buy", optimize=False)

    # Asset classification for allocation
    ASSET_CATEGORIES = {
        'BTC/USD': 'btc',
        'BTC/USDT': 'btc',
        'ETH/USD': 'eth', 
        'ETH/USDT': 'eth',
        'ADA/USD': 'alt',
        'ADA/USDT': 'alt',
        'SOL/USD': 'alt',
        'SOL/USDT': 'alt',
        'DOT/USD': 'alt',
        'DOT/USDT': 'alt',
        'ALGO/USD': 'alt',
        'ALGO/USDT': 'alt',
        'MATIC/USD': 'alt',
        'MATIC/USDT': 'alt',
        'USDC/USD': 'stable',
        'USDT/USD': 'stable'
    }

    def informative_pairs(self):
        """Include major pairs for portfolio context"""
        return [
            ('BTC/USD', self.timeframe),
            ('ETH/USD', self.timeframe),
            ('ADA/USD', self.timeframe),
            ('SOL/USD', self.timeframe)
        ]

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Add indicators for portfolio rebalancing decisions
        """
        # === TREND INDICATORS ===
        dataframe['ema_trend'] = ta.EMA(dataframe, timeperiod=self.trend_ema_period.value)
        dataframe['sma_50'] = ta.SMA(dataframe, timeperiod=50)
        dataframe['sma_200'] = ta.SMA(dataframe, timeperiod=200)
        
        # Trend direction and strength
        dataframe['trend_direction'] = np.where(dataframe['close'] > dataframe['ema_trend'], 1, -1)
        dataframe['trend_strength'] = abs(dataframe['close'] - dataframe['ema_trend']) / dataframe['close']
        
        # === MOMENTUM INDICATORS ===
        dataframe['rsi'] = ta.RSI(dataframe, timeperiod=self.momentum_period.value)
        dataframe['momentum'] = ta.MOM(dataframe, timeperiod=self.momentum_period.value)
        dataframe['roc'] = ta.ROC(dataframe, timeperiod=self.momentum_period.value)
        
        # Momentum score (normalized)
        dataframe['momentum_score'] = (dataframe['rsi'] - 50) / 50  # -1 to 1 scale
        
        # === VOLATILITY INDICATORS ===
        dataframe['atr'] = ta.ATR(dataframe, timeperiod=self.volatility_period.value)
        dataframe['volatility'] = dataframe['atr'] / dataframe['close']
        
        # Bollinger Bands for volatility
        bollinger = qtpylib.bollinger_bands(qtpylib.typical_price(dataframe), 
                                          window=self.volatility_period.value, 
                                          stds=2.0)
        dataframe['bb_lower'] = bollinger['lower']
        dataframe['bb_middle'] = bollinger['mid']
        dataframe['bb_upper'] = bollinger['upper']
        dataframe['bb_width'] = (dataframe['bb_upper'] - dataframe['bb_lower']) / dataframe['bb_middle']
        
        # === VOLUME INDICATORS ===
        dataframe['volume_sma'] = ta.SMA(dataframe['volume'], timeperiod=20)
        dataframe['volume_ratio'] = dataframe['volume'] / dataframe['volume_sma']
        
        # === MARKET STRUCTURE ===
        # Support and resistance
        dataframe['support'] = dataframe['low'].rolling(window=50).min()
        dataframe['resistance'] = dataframe['high'].rolling(window=50).max()
        
        # Price position in range
        dataframe['price_position'] = ((dataframe['close'] - dataframe['support']) / 
                                     (dataframe['resistance'] - dataframe['support']))
        
        # === PORTFOLIO METRICS ===
        # Relative strength vs market (using BTC as proxy)
        if metadata['pair'] != 'BTC/USD':
            try:
                btc_dataframe = self.dp.get_pair_dataframe('BTC/USD', self.timeframe)
                if not btc_dataframe.empty and len(btc_dataframe) == len(dataframe):
                    dataframe['relative_strength'] = (dataframe['close'].pct_change() / 
                                                    btc_dataframe['close'].pct_change()).rolling(window=20).mean()
                else:
                    dataframe['relative_strength'] = 1.0
            except:
                dataframe['relative_strength'] = 1.0
        else:
            dataframe['relative_strength'] = 1.0
        
        return dataframe

    def get_asset_category(self, pair: str) -> str:
        """Get asset category for allocation purposes"""
        return self.ASSET_CATEGORIES.get(pair, 'other')

    def get_target_allocation(self, category: str) -> float:
        """Get target allocation for asset category"""
        targets = {
            'btc': self.target_btc_allocation.value,
            'eth': self.target_eth_allocation.value,
            'alt': self.target_alt_allocation.value,
            'stable': self.target_stable_allocation.value,
            'other': self.target_other_allocation.value
        }
        return targets.get(category, 0.0)

    def calculate_current_allocations(self) -> Dict[str, float]:
        """Calculate current portfolio allocations"""
        try:
            allocations = {'btc': 0.0, 'eth': 0.0, 'alt': 0.0, 'stable': 0.0, 'other': 0.0}
            total_value = 0.0
            
            # Get all open trades
            open_trades = Trade.get_trades_proxy(is_open=True)
            
            for trade in open_trades:
                category = self.get_asset_category(trade.pair)
                trade_value = trade.stake_amount
                allocations[category] += trade_value
                total_value += trade_value
            
            # Add available balance (consider as 'stable' allocation)
            available_balance = self.wallets.get_total_stake_amount() - total_value
            if available_balance > 0:
                allocations['stable'] += available_balance
                total_value += available_balance
            
            # Convert to percentages
            if total_value > 0:
                for category in allocations:
                    allocations[category] = allocations[category] / total_value
            
            return allocations, total_value
            
        except Exception as e:
            logger.error(f"Error calculating allocations: {e}")
            return {'btc': 0.0, 'eth': 0.0, 'alt': 0.0, 'stable': 0.0, 'other': 0.0}, 0.0

    def needs_rebalancing(self, pair: str) -> tuple:
        """Check if portfolio needs rebalancing for this pair"""
        try:
            category = self.get_asset_category(pair)
            target_allocation = self.get_target_allocation(category)
            
            if target_allocation == 0:
                return False, 0.0, "No target allocation"
            
            current_allocations, total_value = self.calculate_current_allocations()
            current_allocation = current_allocations.get(category, 0.0)
            
            # Calculate allocation drift
            allocation_drift = abs(current_allocation - target_allocation)
            
            # Check if drift exceeds threshold
            needs_rebalance = allocation_drift > self.rebalance_threshold.value
            
            # Calculate required position change
            if needs_rebalance:
                target_value = total_value * target_allocation
                current_value = total_value * current_allocation
                position_change = target_value - current_value
                
                # Only rebalance if change is above minimum amount
                if abs(position_change) < self.min_rebalance_amount.value:
                    needs_rebalance = False
                    reason = f"Change too small: ${position_change:.2f}"
                else:
                    reason = f"Drift: {allocation_drift:.1%}, Change: ${position_change:.2f}"
            else:
                position_change = 0.0
                reason = f"Within threshold: {allocation_drift:.1%}"
            
            logger.info(f"Rebalance check for {pair} ({category}): "
                       f"Current: {current_allocation:.1%}, "
                       f"Target: {target_allocation:.1%}, "
                       f"Needs: {needs_rebalance}, "
                       f"Reason: {reason}")
            
            return needs_rebalance, position_change, reason
            
        except Exception as e:
            logger.error(f"Error checking rebalancing for {pair}: {e}")
            return False, 0.0, f"Error: {e}"

    def check_rebalancing_conditions(self, pair: str, dataframe: DataFrame) -> bool:
        """Check if market conditions are suitable for rebalancing"""
        try:
            current_candle = dataframe.iloc[-1]
            
            # === TREND FILTER ===
            if self.use_trend_filter.value:
                # Don't rebalance against strong trends
                trend_strength = current_candle.get('trend_strength', 0)
                if trend_strength > 0.05:  # Strong trend
                    trend_direction = current_candle.get('trend_direction', 0)
                    if trend_direction == -1:  # Strong downtrend
                        logger.info(f"Skipping rebalancing {pair} - strong downtrend")
                        return False
            
            # === VOLATILITY FILTER ===
            if self.use_volatility_filter.value:
                volatility = current_candle.get('volatility', 0)
                if volatility > self.max_portfolio_volatility.value:
                    logger.info(f"Skipping rebalancing {pair} - high volatility: {volatility:.1%}")
                    return False
            
            # === VOLUME CHECK ===
            volume_ratio = current_candle.get('volume_ratio', 1)
            if volume_ratio < 0.5:  # Very low volume
                logger.info(f"Skipping rebalancing {pair} - low volume")
                return False
            
            return True
            
        except Exception as e:
            logger.error(f"Error checking rebalancing conditions for {pair}: {e}")
            return False

    def custom_stake_amount(self, pair: str, current_time: datetime, current_rate: float,
                          proposed_stake: float, min_stake: Optional[float], max_stake: float,
                          leverage: float, entry_tag: Optional[str], side: str,
                          **kwargs) -> float:
        """
        Calculate stake amount based on portfolio allocation targets
        """
        try:
            # Check if this is a rebalancing order
            needs_rebalance, position_change, reason = self.needs_rebalancing(pair)
            
            if not needs_rebalance:
                # No rebalancing needed, use minimal stake or skip
                return min_stake or (proposed_stake * 0.1)
            
            # Calculate appropriate stake amount for rebalancing
            if position_change > 0:  # Need to increase allocation
                stake_amount = min(abs(position_change), max_stake)
            else:  # Need to decrease allocation (handled in exit logic)
                return min_stake or (proposed_stake * 0.1)
            
            # Apply size limits
            total_stake = self.wallets.get_total_stake_amount()
            max_position = total_stake * self.max_position_size.value
            min_position = total_stake * self.min_position_size.value
            
            stake_amount = max(min_position, min(stake_amount, max_position))
            stake_amount = max(stake_amount, min_stake or 0)
            
            logger.info(f"Rebalancing stake for {pair}: ${stake_amount:.2f} - {reason}")
            
            return stake_amount
            
        except Exception as e:
            logger.error(f"Error calculating stake amount for {pair}: {e}")
            return min_stake or proposed_stake

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Entry logic based on rebalancing needs and market conditions
        """
        pair = metadata['pair']
        
        # Check if rebalancing is needed
        needs_rebalance, position_change, reason = self.needs_rebalancing(pair)
        
        if not needs_rebalance or position_change <= 0:
            # No entry needed
            return dataframe
        
        # Check market conditions
        rebalance_conditions = self.check_rebalancing_conditions(pair, dataframe)
        
        # === TECHNICAL CONDITIONS FOR ENTRY ===
        # Prefer to buy on slight dips or at support
        technical_entry = (
            (dataframe['price_position'] < 0.7) |  # Not at resistance
            (dataframe['rsi'] < 60) |  # Not overbought
            (dataframe['close'] <= dataframe['bb_middle'])  # Below BB middle
        )
        
        # === MOMENTUM ADJUSTMENT ===
        if self.momentum_adjustment.value:
            # Increase allocation to assets with positive momentum
            momentum_boost = (
                (dataframe['momentum_score'] > 0) &
                (dataframe['relative_strength'] > 1.0)
            )
        else:
            momentum_boost = True
        
        # === VOLATILITY ADJUSTMENT ===
        if self.volatility_adjustment.value:
            # Prefer lower volatility for rebalancing
            volatility_ok = (
                (dataframe['volatility'] < self.max_portfolio_volatility.value) &
                (dataframe['bb_width'] < 0.15)
            )
        else:
            volatility_ok = True
        
        # === VOLUME CONFIRMATION ===
        volume_ok = (
            (dataframe['volume_ratio'] > 0.8) &  # Decent volume
            (dataframe['volume'] > 0)
        )
        
        # === COMBINED ENTRY CONDITIONS ===
        entry_conditions = (
            rebalance_conditions &
            technical_entry &
            momentum_boost &
            volatility_ok &
            volume_ok
        )
        
        dataframe.loc[entry_conditions, 'enter_long'] = 1
        dataframe.loc[dataframe['enter_long'] == 1, 'enter_tag'] = 'rebalance_buy'
        
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        """
        Exit logic based on rebalancing needs
        """
        pair = metadata['pair']
        
        # Check if we need to reduce allocation (rebalancing sell)
        needs_rebalance, position_change, reason = self.needs_rebalancing(pair)
        
        if needs_rebalance and position_change < 0:
            # Need to reduce allocation
            
            # === TECHNICAL CONDITIONS FOR EXIT ===
            # Prefer to sell on pumps or at resistance
            technical_exit = (
                (dataframe['price_position'] > 0.6) |  # Near resistance
                (dataframe['rsi'] > 60) |  # Overbought
                (dataframe['close'] >= dataframe['bb_middle'])  # Above BB middle
            )
            
            # === MOMENTUM CHECK ===
            # Don't sell into strong momentum unless severely overallocated
            if abs(position_change) > self.min_rebalance_amount.value * 2:
                # Large rebalancing needed - override momentum
                momentum_override = True
            else:
                momentum_override = (dataframe['momentum_score'] < 0.5)
            
            # === VOLUME CONFIRMATION ===
            volume_ok = (dataframe['volume_ratio'] > 0.8)
            
            # === COMBINED EXIT CONDITIONS ===
            exit_conditions = (
                technical_exit &
                (momentum_override | (dataframe['momentum_score'] < 0)) &
                volume_ok
            )
            
            dataframe.loc[exit_conditions, 'exit_long'] = 1
        
        # === REGULAR PROFIT TAKING ===
        # Also exit on strong overbought conditions regardless of rebalancing
        overbought_exit = (
            (dataframe['rsi'] > 80) &
            (dataframe['price_position'] > 0.9) &
            (dataframe['bb_width'] > 0.10)
        )
        
        dataframe.loc[overbought_exit, 'exit_long'] = 1
        
        return dataframe

    def custom_exit_price(self, pair: str, trade: Trade, current_time: datetime,
                        proposed_rate: float, current_profit: float,
                        exit_tag: Optional[str], **kwargs) -> float:
        """
        Custom exit price for rebalancing orders
        """
        if exit_tag and 'rebalance' in exit_tag.lower():
            try:
                # For rebalancing exits, try to get better price
                dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
                if not dataframe.empty:
                    current_candle = dataframe.iloc[-1]
                    
                    # Try to sell at slight premium
                    resistance = current_candle.get('resistance', proposed_rate)
                    bb_upper = current_candle.get('bb_upper', proposed_rate)
                    
                    # Target between current price and resistance/BB upper
                    target_price = min(resistance * 0.99, bb_upper * 0.98)
                    better_price = max(proposed_rate, target_price)
                    
                    if better_price > proposed_rate:
                        logger.info(f"Rebalance exit price improvement for {pair}: "
                                   f"Market: {proposed_rate:.6f}, "
                                   f"Target: {better_price:.6f}")
                        return better_price
            except Exception as e:
                logger.error(f"Error in custom_exit_price for {pair}: {e}")
        
        return proposed_rate

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float,
                          rate: float, time_in_force: str, current_time: datetime,
                          entry_tag: Optional[str], side: str, **kwargs) -> bool:
        """
        Final confirmation for rebalancing entries
        """
        try:
            # Allow rebalancing entries
            if entry_tag and 'rebalance' in entry_tag.lower():
                # Final rebalancing check
                needs_rebalance, position_change, reason = self.needs_rebalancing(pair)
                if needs_rebalance and position_change > 0:
                    logger.info(f"Confirming rebalance entry for {pair}: {reason}")
                    return True
                else:
                    logger.info(f"Rejecting rebalance entry for {pair}: conditions changed")
                    return False
            
            # Reject non-rebalancing entries
            return False
            
        except Exception as e:
            logger.error(f"Error in confirm_trade_entry for {pair}: {e}")
            return False

    def confirm_trade_exit(self, pair: str, trade: Trade, order_type: str, amount: float,
                         rate: float, time_in_force: str, exit_reason: str,
                         current_time: datetime, **kwargs) -> bool:
        """
        Confirm trade exit with rebalancing logic
        """
        try:
            # Always allow stop loss and ROI exits
            if exit_reason in ['stop_loss', 'roi', 'force_exit']:
                return True
            
            # For signal exits, check if it's rebalancing-driven
            if exit_reason == 'exit_signal':
                needs_rebalance, position_change, reason = self.needs_rebalancing(pair)
                if needs_rebalance and position_change < 0:
                    logger.info(f"Confirming rebalance exit for {pair}: {reason}")
                    return True
                else:
                    # Check if it's regular profit taking
                    if trade.calc_profit_ratio(rate) > 0.15:  # 15% profit
                        return True
                    else:
                        logger.info(f"Delaying exit for {pair} - no rebalancing need")
                        return False
            
            return True
            
        except Exception as e:
            logger.error(f"Error in confirm_trade_exit for {pair}: {e}")
            return True

    def leverage(self, pair: str, current_time: datetime, current_rate: float,
                proposed_leverage: float, max_leverage: float, entry_tag: Optional[str],
                side: str, **kwargs) -> float:
        """
        No leverage for portfolio rebalancing strategy
        """
        return 1.0