import numpy as np


'''模型评估函数'''
def forecast_accuracy(forecast, actual):
    '''
    评估函数的集合
    (Recycled from notebook) Returns evaluation metrics given predicted and true values.
    '''
    forecast = np.array(forecast)
    actual = np.array(actual)

    mape = np.mean(np.abs(forecast - actual) / np.abs(actual))  # MAPE

    me = np.mean(forecast - actual)  # ME

    mae = np.mean(np.abs(forecast - actual))  # MAE

    mpe = np.mean((forecast - actual) / actual)  # MPE

    rmse = np.mean((forecast - actual) ** 2) ** .5  # RMSE

    corr = np.corrcoef(forecast, actual)[0, 1]  # corr

    mins = np.amin(np.hstack([forecast[:, None], actual[:, None]]), axis=1)
    maxs = np.amax(np.hstack([forecast[:, None], actual[:, None]]), axis=1)

    minmax = 1 - np.mean(mins / maxs)  # minmax

    return ({'mape': mape, 'me': me, 'mae': mae,
             'mpe': mpe, 'rmse': rmse,
             'corr': corr, 'minmax': minmax})