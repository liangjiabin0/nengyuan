import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from math import sqrt

# model itself
from keras.models import Sequential
from keras.layers import LSTM, Dropout
from keras.layers import Dense
from sklearn.metrics import mean_absolute_error, mean_squared_error
# from keras.losses import mean_absolute_percentage_error
from keras import backend as K
import matplotlib.lines as mlines

df = pd.read_csv('pvdaq_2012_2014_hourly.csv', header=0, infer_datetime_format=True, parse_dates=['Date-Time'], index_col=['Date-Time'])

# print(df) # 打印输入文件
# print(df.dtypes) # 答应列名

# columns to use for forecasting 提取预测所需数据
cols = ['ambient_temp', 'inverter_temp', 'module_temp', 'poa_irradiance',
        'relative_humidity', 'wind_direction', 'wind_speed']
time_indexes = [df.index.hour, df.index.month]
# we will forecast dc power output
target = ['dc_power']

# array stacking
def create_sequence(df, cols, target):
  seqs = []
  for col in cols:
    seq = df[col].values.reshape((len(df[col]), 1))
    seqs.append(seq)
  for index in time_indexes:
    seq = index.values.reshape((len(df[col]), 1))
    seqs.append(seq)
  seq = df[target].values.reshape((len(df[target]), 1))
  for i in range(len(seq)):
    if seq[i] < 0:
      seq[i] = 0
  seqs.append(seq)
  dataset = np.hstack((seqs))
  return dataset

dataset = (create_sequence(df, cols, target))

print(dataset.shape)

# single step multivariate sequence
def split_sequence(sequence, n_steps):
  X, y = list(), list()
  for i in range(len(sequence)):
    end_ix = i + n_steps
    # check if we are not beyond range
    if end_ix > len(sequence)-1:
      break
    seq_x, seq_y = sequence[i:end_ix, :], sequence[end_ix ,-1]
    X.append(seq_x)
    y.append(seq_y)
  return np.array(X), np.array(y)

X, y = split_sequence(dataset, 4)
print(X. shape, y.shape)
print(df.head(1), y[11])


def split_sequence_multi(sequence, n_steps, n_steps_out):
  X, y = list(), list()
  for i in range(len(sequence)):
    end_ix = i + n_steps
    out_ix = end_ix + n_steps_out
    # boundary check
    if out_ix > len(sequence):
      break
    seq_x, seq_y = sequence[i:end_ix, :], sequence[end_ix:out_ix, -1]
    X.append(seq_x)
    y.append(seq_y)
  return np.array(X), np.array(y)

X, y = split_sequence_multi(dataset, 12, 6)
print(X.shape, y.shape)
print(X[0][0], y[0])
# n_steps is amount of time steps per sample
# n_steps_out is the amount of time steps model has to forecast
n_steps, n_steps_out = 24, 6
# number of features in each timestep
n_features=X.shape[2]
X, y = split_sequence_multi(dataset, n_steps, n_steps_out)
train_X, train_y = X[:-2000,:], y[:-2000,:]
val_X, val_y = X[-2000:-1000,:], y[-2000:-1000,:]
test_X, test_y = X[-1000:,:], y[-1000:,:]

model = Sequential()
model.add(LSTM(300, activation='relu', return_sequences=True, input_shape=(n_steps, n_features)))
model.add(LSTM(200, activation='relu'))
model.add(Dense(n_steps_out))
# model.compile(optimizer='adam', loss='mse')
model.compile(optimizer='adam', loss='mse')

model.fit(train_X, train_y, batch_size=32, epochs = 20, validation_data=(val_X, val_y))
# A stateful recurrent model is one for which the internal states (memories)
# obtained after processing a batch of samples are reused as initial states for the samples of the next batch

predictions = model.predict(test_X)

# https://en.wikipedia.org/wiki/Symmetric_mean_absolute_percentage_error
# def sMAPE(y_true, y_pred):
#     #Symmetric mean absolute percentage error
#     100 * K.mean(K.abs(y_pred - y_true) / (K.abs(y_pred) + K.abs(y_true)), axis=-1)

predictions1 = model.predict(train_X)
# mse = mean_squared_error(train_y, predictions1)
# rmse = sqrt(mse)
# mae = mean_absolute_error(train_y, predictions1)
# #mape = mean_absolute_percentage_error(predictions1, test_y)
# print(round(mse), round(rmse), round(mae))
#
# mse = mean_squared_error(test_y, predictions)
# rmse = sqrt(mse)
# mae = mean_absolute_error(test_y, predictions)
# #mape = mean_absolute_percentage_error(test_y, predictions)
# #smape = sMAPE(test_y, predictions)
# print(round(mse), round(rmse), round(mae))


for i in range(len(test_y)):
  print("prediction" + str(i))
  for j in range(n_steps_out):
    print(int(abs(test_y[i][j]-predictions[i][j])), int(test_y[i][j]), int(predictions[i][j]))

test_seq1 = []
pred_seq1 = []
for i in range(36):
  test_seq1 = np.concatenate((test_seq1, test_y[i*6]))
  pred_seq1 = np.concatenate((pred_seq1, predictions[i*6]))



blue_line = mlines.Line2D([], [], color='blue', marker='s',
                          markersize=5, label='Truth')
red_line = mlines.Line2D([], [], color='red', marker='p',
                          markersize=5, label='Prediction')

# plt.legend(handles=[blue_line, red_line])


plt.figure(figsize=(18,10))
plt.plot(test_seq1, 'b-s')
plt.plot(pred_seq1, 'r--p')
plt.legend(handles=[blue_line, red_line])
plt.show()

test_seq = np.concatenate((test_y[0], test_y[6], test_y[12], test_y[18], test_y[24], test_y[30], test_y[36]))
pred_seq = np.concatenate((predictions[0], predictions[6], predictions[12], predictions[18], predictions[24], predictions[30], predictions[36]))
plt.plot(test_seq)
plt.plot(pred_seq)
plt.show()

