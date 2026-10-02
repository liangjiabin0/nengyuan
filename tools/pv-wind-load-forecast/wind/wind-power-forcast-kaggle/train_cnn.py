import missingno as msno
import numpy as np
import pandas as pd
np.seterr(divide='ignore', invalid='ignore')
import matplotlib.pyplot as plt, seaborn as sns
from sklearn.preprocessing import MinMaxScaler
from pandas.plotting import autocorrelation_plot
from statsmodels.graphics.gofplots import qqplot
from keras.callbacks import EarlyStopping, ModelCheckpoint
from keras.layers import Dense, Dropout, LeakyReLU, BatchNormalization, Conv2D, Flatten, Input
from keras.optimizers import Adam
from keras import Model
from pyts.image import GramianAngularField as GAF
from mpl_toolkits.axes_grid1 import ImageGrid
from utils import forecast_accuracy

series = pd.read_csv("Turbine_Data.csv")

'''
Visualisations and missing values
'''
# 该数据集显示了22个特征的118224个观测值，但部分特征存在明显的数据缺失期。
# 我们需要丢弃一些时间段并填充缺失的时间段，否则我们的LSTM模型将不收敛或者我们可能最终用垃圾数据来喂养它。
# msno矩阵图最右边部分表示数据的完整程度，表示数据集的后半部分更完整。我们将努力利用这部分进行训练和测试。
print(msno.matrix(series))

'''
相关性分析
'''
# 相关图显示多个特征之间高度正相关，这会使它们之间存在冗余。分离这些特征将有助于避免维数灾难。
# 对于本演示，我们将只关注目标Y - - ' ActivePower '，以及预测特征- - ' WindSpeed '。这进一步简化了我们的任务。
# 如果你碰巧有关于风力发电机的机械工程专业知识，你会知道风力发电大部分是依赖于天气条件(例如,风速)，因此你可以丢弃其余的功能
plt.subplots(figsize=(16, 16))
sns.heatmap(series.corr(), annot=True, square=True)
plt.show()

'''
预处理
'''
# 剔除无关的值
idxs = []

# 我们首先去除了所有与有功功率没有相关性的特征
for i, corr in enumerate(series.corr()['ActivePower']):
    if corr > 0 and pd.notna(corr):
        idxs.append(i)

idxs = idxs[1:]
selected_features = series.corr()['ActivePower'][idxs]

# now we can cualitatively eliminate some features that are redundant, i.e. they have high correlation
# and they physically correspond to a similar event (gearbox bearing T and gearbox oil T)

# 现在我们可以逐步消除一些冗余的特征，即它们具有高度相关性
# 与它们物理上对应一个类似的事件(齿轮箱轴承T和齿轮箱油T)
selected_features = selected_features.drop(
    labels=['GearboxOilTemperature', 'GeneratorWinding1Temperature', 'RotorRPM', 'NacellePosition'])
sel_feature_names = [idx for idx, val in selected_features.iteritems()]
# don't forget ActivePower 有功功率
sel_feature_names.insert(0, 'ActivePower')
reduced_df = series[sel_feature_names]
print(f"The selected features are:\n{sel_feature_names}")

# we can see that there are still some big chunks of missing data among our selected features
msno.matrix(reduced_df, figsize=(10,5))
plt.show()

'''pre-processing from the baseline'''

# generate timestamp for the observations mimicking the "unnamed:0" feature
# 填写一列时间
rng = pd.date_range('2017-12-31', periods=118224, freq='10T')
time_df = pd.DataFrame(rng)
# fill in missing values with zero using the fillforward function
# 利用填充函数将缺失值填充为零
reduced_df = reduced_df.fillna(0).astype(float)
# concatenate both the timestamp range and filled in features
# 将时间戳范围和填充特征进行拼接
reduced_df = pd.concat((time_df, reduced_df), axis=1)
# set up index
reduced_df = reduced_df.set_index(0)
# select a subset of data period from second half of original dataset,
# to ensure we have better quality signal (see completness comment of msno matrix plot above in the code)
# 从原始数据集的后半部分中选择数据时段的子集。
# 保证我们有更好质量的信号(见代码中上面msno矩阵图的完备性注释)

reduced_df = reduced_df.loc['2019-12-17':]

# scales back from normalized values
# 反归一化
def invert_values(y_pred, y_test, scaler) -> tuple:
    '''
    De-normalizes the predicted and true values given a scaler.
    反归一化
    '''
    n_ahead = 144
    rng = pd.date_range('2017-12-31', periods=118224, freq='10T')
    time_df = pd.DataFrame(rng)

    # Creating the predictions date range
    days = time_df.values[-len(y_pred):-len(y_pred) + n_ahead]
    days_df = pd.DataFrame(days)

    pred_n_ahead = pd.DataFrame(y_pred)
    actual_n_ahead = pd.DataFrame(y_test)

    # repeat the column series n times (being n the number of features used), to make shape compatible for scale inversion
    pr_p = pd.concat([pred_n_ahead] * len(sel_feature_names), axis=1)
    ac_p = pd.concat([actual_n_ahead] * len(sel_feature_names), axis=1)

    # inverse scale tranform the series back to kiloWatts of power
    pred_power = scaler.inverse_transform(pr_p)[:, 0]
    actual_power = scaler.inverse_transform(ac_p)[:, 0]

    return pred_power, actual_power



def plot_random_predictions(pred_power, actual_power, n_predictions=6):
    '''
    Plots the prediction of 6 randomly selected days (out of the 21 predicted)
    The zeros that are filled in during pre-processing are marked in lime green
    对随机选取的6天(在预测的21个中)进行预测作图
    预处理时填入的零点用灰绿色标记
    '''
    if n_predictions > 21:
        print('Error: there are only 21 days in the predicted set')
        return

    # 21 days in total
    days = np.arange(0, 21)
    np.random.shuffle(days)

    # we assume hard zeros are the ones forced by pre-processing
    cond_color = np.where(actual_power == 0, 'lime', plt.rcParams['axes.prop_cycle'].by_key()['color'][0])

    fig, ax = plt.subplots(3, 2, figsize=(30, 20))

    ax_h = 0
    ax_v = 0
    for i in range(0, n_predictions):
        ax[ax_h, ax_v].plot(rng[days[i] * 144:(days[i] + 1) * 144], actual_power[days[i] * 144:(days[i] + 1) * 144],
                            label="actual")
        ax[ax_h, ax_v].scatter(rng[days[i] * 144:(days[i] + 1) * 144], actual_power[days[i] * 144:(days[i] + 1) * 144],
                               color=cond_color[days[i] * 144:(days[i] + 1) * 144])
        ax[ax_h, ax_v].plot(rng[days[i] * 144:(days[i] + 1) * 144], pred_power[days[i] * 144:(days[i] + 1) * 144],
                            marker='o', label="prediction")
        ax[ax_h, ax_v].legend()
        ax[ax_h, ax_v].set_title(f"Predicted vs. Actual Power (Day {days[i] + 1})")
        ax[ax_h, ax_v].set_xlabel("Time")
        ax[ax_h, ax_v].set_ylabel("Power (kW)")
        if i % 2 == 0:
            ax_v = 1
        else:
            ax_h += 1
            ax_v = 0

    plt.show()

# 归一化
scaler = MinMaxScaler()
scaler.fit(reduced_df.values)
data_scaled = scaler.transform(reduced_df.values)
'''
总共有105天，因此更容易将它们按天数拆分，而不是使用一个比例，如果得到的形状不是144的倍数，则可以减少一天(分辨率10min)
'''
# we split the data twice: for regression and for training of nn
# 这里的回归和训练指的是后文用了不同的模型，回归模型及神经网络的模型，所以产生了不同的数据集
# 拆分数据集用以训练、验证、测试


test_split_days = 21 # 20%
val_split_days = 10 # around 10%

test_split_idx = len(reduced_df)-144*test_split_days
val_split_idx = test_split_idx-144*val_split_days

print("-- Regression --")
train_data = data_scaled[:test_split_idx]
test_data = data_scaled[test_split_idx:]
print(f"Train data shape: {train_data.shape}\nTest data shape: {test_data.shape}\n")

print("-- NN --")
train_data_nn = data_scaled[:val_split_idx]
val_data_nn = data_scaled[val_split_idx:test_split_idx]
test_data_nn = data_scaled[test_split_idx:]
print(f"Train data shape: {train_data_nn.shape}\nVal data shape: {val_data_nn.shape}\nTest data shape: {test_data_nn.shape}")

print("-- Regression --")
x_train, y_train = train_data[:,1:], train_data[:,0]
print(f"Train values shape: {x_train.shape}\nTrain labels shape: {y_train.shape}")

x_test, y_test = test_data[:,1:], test_data[:,0]
print(f"Test values shape: {x_train.shape}\nTest labels shape: {y_train.shape}\n")

print("-- NN --")
x_train_nn, y_train_nn = train_data_nn[:,1:], train_data_nn[:,0]
print(f"Train values shape: {x_train_nn.shape}\nTrain labels shape: {y_train_nn.shape}")

x_val_nn, y_val_nn = val_data_nn[:,1:], val_data_nn[:,0]
print(f"Val values shape: {x_val_nn.shape}\nVal labels shape: {y_val_nn.shape}")

x_test_nn, y_test_nn = test_data_nn[:,1:], test_data_nn[:,0]
print(f"Test values shape: {x_test_nn.shape}\nTest labels shape: {y_test_nn.shape}\n")

'''
CNN model
We're going to try a final resort for a neural network to perform well.
Here we're using Gramian Angular Fields to convert the time series to image of size nxn being n the number of features. These images transform therefore every time point to a pixel in a non-cartesian way. Considering than CNNs are quite powerful, maybe they are able to improve the score over RNNs.


'''

x_train_reshaped, x_val_reshaped, x_test_reshaped = x_train_nn.reshape(-1, 144, 9), x_val_nn.reshape(-1, 144, 9), \
                                                    x_test_nn.reshape(-1, 144, 9)
y_train_reshaped, y_val_reshaped, y_test_reshaped = y_train_nn.reshape(-1, 144), y_val_nn.reshape(-1, 144), \
                                                    y_test_nn.reshape(-1, 144)

features_data = reduced_df.values[:,1:]

# GAF does min max scaling already
gadf_scaler = GAF(method='s', sample_range=(0,1))
gadf_scaler.fit(features_data)

# we have to reobtain the x_train, x_val and x_test, reshaping them to 4 dimensions to fit the input size
x_train_cnn = gadf_scaler.transform(features_data[:val_split_idx])
x_train_cnn = x_train_cnn.reshape(x_train_cnn.shape[0], x_train_cnn.shape[1], x_train_cnn.shape[2], 1)

x_val_cnn = gadf_scaler.transform(features_data[val_split_idx:test_split_idx])
x_val_cnn = x_val_cnn.reshape(x_val_cnn.shape[0], x_val_cnn.shape[1], x_val_cnn.shape[2], 1)

x_test_cnn = gadf_scaler.transform(features_data[test_split_idx:])
x_test_cnn = x_test_cnn.reshape(x_test_cnn.shape[0], x_test_cnn.shape[1], x_test_cnn.shape[2], 1)

### model parameters
depth = 3
kernel_size = (3, 3)
lrelu_alpha = 0.2
dropout = 0.4
n_filters = 32

inputs = Input(shape=x_train_cnn.shape[1:])
b = inputs
for i in range(1, depth + 1):
    a = Conv2D(filters=n_filters * i, kernel_size=kernel_size, activation=None)(b)
    x = LeakyReLU(alpha=lrelu_alpha)(a)
    x = BatchNormalization()(x)
    b = Dropout(dropout)(x)

a = Conv2D(filters=n_filters * (i + 1), kernel_size=kernel_size, activation=None)(x)
x = LeakyReLU(alpha=lrelu_alpha)(a)
x = BatchNormalization()(x)
x = Flatten()(x)
x = Dropout(dropout)(x)

outputs = Dense(units=1, activation='sigmoid')(x)

model_cnn = Model(inputs, outputs)

model_cnn.summary()
# plot_model(model_cnn)

# compile parameters
lr = 1e-4

# callbacks parameters
patience = 10
min_delta_patience = 1e-4
loss = 'mae'
metrics = 'mae'
checkpoint_path = 'best_cnn.hdf5'

weights_save = ModelCheckpoint(checkpoint_path, save_best_only=True, monitor='val_loss', mode='min')
early_stopping = EarlyStopping(monitor='val_loss', patience=patience, min_delta=min_delta_patience)
model_cnn.compile(optimizer = Adam(learning_rate=lr), loss=loss, metrics=metrics)

# running parameters
epochs = 100
batch_size = 32

history_cnn = model_cnn.fit(x_train_cnn,
                            y_train_nn,
                            epochs=epochs,
                            batch_size=batch_size,
                            validation_data=(x_val_cnn, y_val_nn),
                            shuffle=False,
                            callbacks=[early_stopping, weights_save])

plt.plot(history_cnn.history['loss'], label='Training loss')
plt.plot(history_cnn.history['val_loss'], label = 'Validation loss')
plt.legend()
plt.grid()
plt.show()

model_cnn.load_weights(checkpoint_path)


y_pred_cnn = model_cnn.predict(x_test_cnn)
pred_power_cnn, actual_power_cnn = invert_values(y_pred_cnn.reshape(-1, ), y_test_nn, scaler)

forecast_accuracy(pred_power_cnn, actual_power_cnn)

plot_random_predictions(pred_power_cnn, actual_power_cnn)

residuals_cnn = pd.Series(pred_power_cnn-actual_power_cnn)
residuals_cnn.describe()

fig, ax = plt.subplots(2,2, figsize=(20,10))
residuals_cnn.plot(kind='hist', title="Residuals", ax=ax[0,0])
residuals_cnn.plot(kind='kde', title='Density', ax=ax[0,1])
qqplot(residuals_cnn, ax=ax[1,0])
autocorrelation_plot(residuals_cnn, ax=ax[1,1])
plt.show()

layer_outputs = [layer.output for layer in model_cnn.layers]
feature_map_model = Model(inputs=model_cnn.inputs, outputs=layer_outputs)
feature_maps = feature_map_model.predict(x_test_cnn)

for i, layer in enumerate(model_cnn.layers):
    if 'conv' in layer.name:
        print(i)

# convolutions at layers 1, 5, 9, ...
show_layer = 9

fig = plt.figure(figsize=(10, 5))

grid = ImageGrid(fig, 111, nrows_ncols=(5, 10), axes_pad=0.1, share_all=True,
                 cbar_mode='single')
for i, ax in enumerate(grid):
    im = ax.imshow(feature_maps[show_layer][0, :, :, i], origin='lower', vmin=-1., vmax=1.)

grid[0].get_yaxis().set_ticks([])
grid[0].get_xaxis().set_ticks([])
plt.colorbar(im, cax=grid.cbar_axes[0])
ax.cax.toggle_label(True)

fig.suptitle(f"Feature maps for layer {model_cnn.layers[show_layer].name}", y=0.92)
plt.show()