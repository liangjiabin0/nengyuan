import pandas as pd
import missingno as msno   
import numpy as np
import matplotlib.pyplot as plt, seaborn as sns
from sklearn.svm import SVR
from sklearn.preprocessing import MinMaxScaler
from pandas.plotting import autocorrelation_plot
from statsmodels.graphics.gofplots import qqplot
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
sns.heatmap(series.corr(numeric_only=True), annot=True, square=True)
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

print('==============补全后的数据=================')
#reduced_df.to_excel('补全后的数据.xlsx',index = False)
reduced_df['BearingShaftTemperature'] = reduced_df['BearingShaftTemperature'].mean()
reduced_df['GearboxBearingTemperature'] = reduced_df['GearboxBearingTemperature'].mean()
reduced_df['GeneratorRPM'] = reduced_df['GeneratorRPM'].mean()
reduced_df['GeneratorWinding2Temperature'] = reduced_df['GeneratorWinding2Temperature'].mean()
reduced_df['MainBoxTemperature'] = reduced_df['MainBoxTemperature'].mean()
reduced_df['HubTemperature'] = reduced_df['HubTemperature'].mean()
reduced_df['ReactivePower'] = reduced_df['ReactivePower'].mean()
print(reduced_df)



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
#print(data_scaled)


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
第一个模型：支持向量回归(SVR)
'''

# cv_params = {'epsilon': np.linspace(0,0.1,9),'C': np.linspace(1,10,10)}
# 84 folds would take a day per fold. Therefore we take lower multiples
#     grid = GridSearchCV(SVR(), cv_params, scoring='neg_mean_absolute_error', cv=21, n_jobs=4, verbose=1)
# 4 days per fold
#    grid.fit(x_train, y_train)
#     print(f"The best model has parameters C={grid.best_params_['C']} and epsilon={grid.best_params_['epsilon']}")

# predict using the best model
# y_pred_svr = grid.best_estimator_.predict(x_test)

svr_model = SVR(epsilon=0.0, C=2.0)
svr_model.fit(x_train, y_train)

#predict
y_pred_svr = svr_model.predict(x_test)

# de-normalize values
pred_power_svr, actual_power_svr = invert_values(y_pred_svr, y_test, scaler)

# get scores
forecast_accuracy(pred_power_svr, actual_power_svr)

plot_random_predictions(pred_power_svr, actual_power_svr)

'''
残差分析
'''
residuals_svr = pd.Series(pred_power_svr-actual_power_svr)
print(residuals_svr.describe())

fig, ax = plt.subplots(2,2, figsize=(20,10))
residuals_svr.plot(kind='hist', title="Residuals", ax=ax[0,0])
residuals_svr.plot(kind='kde', title='Density', ax=ax[0,1])
qqplot(residuals_svr, ax=ax[1,0])
autocorrelation_plot(residuals_svr, ax=ax[1,1])
plt.show()