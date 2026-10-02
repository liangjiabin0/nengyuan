import os
import datetime

import IPython
import IPython.display
import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
import tensorflow as tf

mpl.rcParams['figure.figsize'] = (8, 6)
mpl.rcParams['axes.grid'] = False

# to display all columns
pd.options.display.max_columns = None
pd.options.display.max_rows = None

# read the data
data = pd.read_csv('Turbine_Data.csv')
# print(data.head())
#print(data.info())
#print(data.describe())

# change the Unnamed: 0 to datetype
df_updated = data.copy()
df_updated['Unnamed: 0'] = pd.to_datetime(df_updated['Unnamed: 0'])
df_updated.rename(columns={'Unnamed: 0': 'date_column'}, inplace=True)

if (df_updated['Blade2PitchAngle'].equals(df_updated['Blade3PitchAngle'])==True):
  df_updated = df_updated.drop('Blade3PitchAngle', axis=1)

# check if the column is dropped
assert 'Blade3PitchAngle' not in df_updated.columns

df_updated.head()

# Check null values
df_updated.isnull().sum()

df_updated = df_updated.fillna(method='ffill').fillna(method='bfill')
df_updated.isnull().sum()

df = df_updated[['date_column', 'ActivePower', 'WindSpeed', 'GeneratorRPM', 'ReactivePower', 'RotorRPM', 'AmbientTemperatue', \
                 'WindDirection', 'Blade1PitchAngle', 'Blade2PitchAngle', 'HubTemperature', 'MainBoxTemperature', 'GearboxBearingTemperature', \
                 'GearboxOilTemperature']].copy()

# crete a new column called Weekday
df['weekday'] = df['date_column'].dt.dayofweek
# get one hot encoding
ohe = pd.get_dummies(df['weekday'])
df = df.join(ohe)
df = df.drop('weekday', axis=1)
date = pd.to_datetime(df.pop('date_column'))
df.head()

# convert datetime column to seconds
import datetime
timestamp_s = date.map(datetime.datetime.timestamp)

# time in seconds may not be an useful input. We could convert it into sin and cos
day = 24*60*60
year = (365.2425)*day

df.head()


df['Day sin'] = np.sin(timestamp_s * (2 * np.pi / day))
df['Day cos'] = np.cos(timestamp_s * (2 * np.pi / day))
df['Year sin'] = np.sin(timestamp_s * (2 * np.pi / year))
df['Year cos'] = np.cos(timestamp_s * (2 * np.pi / year))


plt.plot(np.array(df['Day sin'])[:200])
plt.plot(np.array(df['Day cos'])[:200])
plt.xlabel('Time [h]')
plt.title('Time of day signal')
plt.show()

column_indices = {name: i for i, name in enumerate(df.columns)}

n = len(df)
train_df = df[0:int(n*0.7)]
val_df = df[int(n*0.7):int(n*0.9)]
test_df = df[int(n*0.9):]

num_features = df.shape[1]

df.head()

# Normalize the data
train_mean = train_df.mean()
train_std = train_df.std()

train_df = (train_df - train_mean) / train_std
val_df = (val_df - train_mean) / train_std
test_df = (test_df - train_mean) / train_std

# the code below visualizes the normalized data
df_std = (df - train_mean) / train_std
df_std = df_std.melt(var_name='Column', value_name='Normalized')
plt.figure(figsize=(12, 6))
ax = sns.violinplot(x='Column', y='Normalized', data=df_std)
_ = ax.set_xticklabels(df.keys(), rotation=90)
plt.show()

class WindowGenerator():
  def __init__(self, input_width, label_width, shift,
               train_df=train_df, val_df=val_df, test_df=test_df,
               label_columns=None):
    # Store the raw data.
    self.train_df = train_df
    self.val_df = val_df
    self.test_df = test_df

    # Work out the label column indices.
    self.label_columns = label_columns
    if label_columns is not None:
      self.label_columns_indices = {name: i for i, name in
                                    enumerate(label_columns)}
    self.column_indices = {name: i for i, name in
                           enumerate(train_df.columns)}

    # Work out the window parameters.
    self.input_width = input_width
    self.label_width = label_width
    self.shift = shift

    self.total_window_size = input_width + shift
    self.input_slice = slice(0, input_width)
    self.input_indices = np.arange(self.total_window_size)[self.input_slice]

    self.label_start = self.total_window_size - self.label_width
    self.labels_slice = slice(self.label_start, None)
    self.label_indices = np.arange(self.total_window_size)[self.labels_slice]

  def __repr__(self):
    return '\n'.join([
        f'Total window size: {self.total_window_size}',
        f'Input indices: {self.input_indices}',
        f'Label indices: {self.label_indices}',
        f'Label column name(s): {self.label_columns}'])

w2 = WindowGenerator(input_width=30*24*6, label_width=15*24*6, shift=15*24*6,
                     label_columns=['ActivePower'])

w2

def split_window(self, features):
  inputs = features[:, self.input_slice, :]
  labels = features[:, self.labels_slice, :]
  if self.label_columns is not None:
    labels = tf.stack(
        [labels[:, :, self.column_indices[name]] for name in self.label_columns],
        axis=-1)

  # Slicing doesn't preserve static shape information, so set the shapes
  # manually. This way the `tf.data.Datasets` are easier to inspect.
  inputs.set_shape([None, self.input_width, None])
  labels.set_shape([None, self.label_width, None])

  return inputs, labels

WindowGenerator.split_window = split_window

# Stack three slices, the length of the total window:
example_window = tf.stack([np.array(train_df[:w2.total_window_size]),
                           np.array(train_df[100:100+w2.total_window_size]),
                           np.array(train_df[200:200+w2.total_window_size])])


example_inputs, example_labels = w2.split_window(example_window)

print('All shapes are: (batch, time, features)')
print(f'Window shape: {example_window.shape}')
print(f'Inputs shape: {example_inputs.shape}')
print(f'labels shape: {example_labels.shape}')

w2.example = example_inputs, example_labels

def plot(self, model=None, plot_col='ActivePower', max_subplots=5):
  inputs, labels = self.example
  plt.figure(figsize=(70, 20))
  plot_col_index = self.column_indices[plot_col]
  max_n = min(max_subplots, len(inputs))
  for n in range(max_n):
    plt.subplot(max_n, 1, n+1)
    plt.ylabel(f'{plot_col} [normed]')
    plt.plot(self.input_indices, inputs[n, :, plot_col_index],
             label='Inputs', marker='.', zorder=-10)

    if self.label_columns:
      label_col_index = self.label_columns_indices.get(plot_col, None)
    else:
      label_col_index = plot_col_index

    if label_col_index is None:
      continue

    plt.scatter(self.label_indices, labels[n, :, label_col_index],
                edgecolors='k', label='Labels', c='#2ca02c', s=124)
    if model is not None:
      predictions = model(inputs)
      plt.scatter(self.label_indices, predictions[n, :, label_col_index],
                  marker='X', label='Predictions',
                  c='#ff0000', s=154)

    if n == 0:
      plt.legend(prop={'size': 20})

  plt.xlabel('Time [20 min]')
  plt.show()

WindowGenerator.plot = plot

w2.plot()

def make_dataset(self, data):
  data = np.array(data, dtype=np.float32)
  ds = tf.keras.preprocessing.timeseries_dataset_from_array(
      data=data,
      targets=None,
      sequence_length=self.total_window_size,
      sequence_stride=1,
      shuffle=True,
      batch_size=120,)

  ds = ds.map(self.split_window)

  return ds

WindowGenerator.make_dataset = make_dataset

@property
def train(self):
  return self.make_dataset(self.train_df)

@property
def val(self):
  return self.make_dataset(self.val_df)

@property
def test(self):
  return self.make_dataset(self.test_df)

@property
def example(self):
  """Get and cache an example batch of `inputs, labels` for plotting."""
  result = getattr(self, '_example', None)
  if result is None:
    # No example batch was found, so get one from the `.train` dataset
    result = next(iter(self.train))
    # And cache it for next time
    self._example = result
  return result

WindowGenerator.train = train
WindowGenerator.val = val
WindowGenerator.test = test
WindowGenerator.example = example

# Each element is an (inputs, label) pair
w2.train.element_spec
for example_inputs, example_labels in w2.train.take(1):
  print(f'Inputs shape (batch, time, features): {example_inputs.shape}')
  print(f'Labels shape (batch, time, features): {example_labels.shape}')
