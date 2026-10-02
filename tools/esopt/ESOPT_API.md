# ESOPT建模工具API文档

## 基本数据结构

### 基本设置
```cpp
using IndexT = int;
using CoeffT = double;

constexpr CoeffT COEFTHRESHOLD = 1e-12;

template <typename K, typename V>
using Hashmap = ankerl::unordered_dense::map<K, V>;

template <typename K>
using Hashset = ankerl::unordered_dense::set<K>;

template <typename V>
using Vector = std::vector<V>;
```

### 变量类型
```cpp
enum class VariableDomain
{
	Continuous,
	Integer,
	Binary,
};
```
### 变量
```cpp
class MODEL_API VariableIndex
{
  public:
	VariableIndex() = default;
	VariableIndex(IndexT v) : index(v) {};

  public:
	IndexT index;
};
```

### 约束
```cpp
class ConstraintIndex
{
  public:
	ConstraintIndex() = default;
	ConstraintIndex(ConstraintType t, int i) : type(t), index(i)
	{
	}

  public:
	ConstraintType type;
	int index;
};
```

### 约束比较
```cpp
enum class ConstraintSense
{
	// <=
	LessEqual,
	// >=
	GreaterEqual,
	// ==
	Equal,
};
```

### 线性、二次表达式
实现了四则运算的重载，可以直接写表达式。可以构建较复杂的表达式。
```cpp
struct MODEL_API ExprBuilder
{
	Hashmap<VariablePair, CoeffT> quadratic_terms;
	Hashmap<IndexT, CoeffT> affine_terms;
	std::optional<CoeffT> constant_term;

	ExprBuilder() = default;
	ExprBuilder(CoeffT c);
	ExprBuilder(const VariableIndex &v);
	ExprBuilder(const ScalarAffineFunction &a);
	ExprBuilder(const ScalarQuadraticFunction &q);

	ExprBuilder &operator+=(CoeffT c);
	ExprBuilder &operator+=(const VariableIndex &v);
	ExprBuilder &operator+=(const ScalarAffineFunction &a);
	ExprBuilder &operator+=(const ScalarQuadraticFunction &q);
	ExprBuilder &operator+=(const ExprBuilder &t);

	ExprBuilder &operator-=(CoeffT c);
	ExprBuilder &operator-=(const VariableIndex &v);
	ExprBuilder &operator-=(const ScalarAffineFunction &a);
	ExprBuilder &operator-=(const ScalarQuadraticFunction &q);
	ExprBuilder &operator-=(const ExprBuilder &t);

	ExprBuilder &operator*=(CoeffT c);
	ExprBuilder &operator*=(const VariableIndex &v);
	ExprBuilder &operator*=(const ScalarAffineFunction &a);
	ExprBuilder &operator*=(const ScalarQuadraticFunction &q);
	ExprBuilder &operator*=(const ExprBuilder &t);

	ExprBuilder &operator/=(CoeffT c);

	bool empty() const;
	int degree() const;

	void reserve_quadratic(size_t n);
	void reserve_affine(size_t n);

	void clear();
	void clean_nearzero_terms(CoeffT threshold = COEFTHRESHOLD);
	void _add_quadratic_term(IndexT i, IndexT j, CoeffT coeff);
	void _set_quadratic_coef(IndexT i, IndexT j, CoeffT coeff);
	void add_quadratic_term(const VariableIndex &i, const VariableIndex &j, CoeffT coeff);
	void set_quadratic_coef(const VariableIndex &i, const VariableIndex &j, CoeffT coeff);
	void _add_affine_term(IndexT i, CoeffT coeff);
	void _set_affine_coef(IndexT i, CoeffT coeff);
	void add_affine_term(const VariableIndex &i, CoeffT coeff);
	void set_affine_coef(const VariableIndex &i, CoeffT coeff);
};
```

### 非线性表达式
重载了四则运算，和常用非线性函数，如sin、cos、pow等，可直接写表达式。可以构建较复杂的表达式。
```cpp
struct ExpressionHandle
{
	ArrayType array;
	NodeId id;

	bool operator==(const ExpressionHandle &x) const;

	ExpressionHandle() = default;
	ExpressionHandle(ArrayType array, NodeId id) : array(array), id(id)
	{
	}

	std::string to_string() const;
};
```

### 非线性约束求导上下文
使用RAII管理上下文，保存非线性约束表达式，在添加非线性约束时使用。
```cpp
class MODEL_API ExpressionGraphContextGuard
{
public:
	ExpressionGraphContextGuard();
	~ExpressionGraphContextGuard();

	ExpressionGraphContextGuard(const ExpressionGraphContextGuard&) = delete;
	ExpressionGraphContextGuard& operator=(const ExpressionGraphContextGuard&) = delete;

	std::shared_ptr<ExpressionGraph> graph() { return _graph; }

private:
	std::shared_ptr<ExpressionGraph> _graph;
};
```

## 建模工具API

### 加载求解器
```cpp
#include "knitro_model.h"
#include "ipopt_model.h"
#include "highs_model.h"

bool load_library(const std::string &path);

示例：
std::string lib_knitro = "/home/whz/projects/test_cpp_esopt/Knitro_nolimit/libknitro1420.so"; 
std::string lib_highs = "/usr/local/lib/libhighs.so";
std::string lib_ipopt = "/usr/local/lib/libipopt.so";

knitro::load_library(lib_knitro);
highs::load_library(lib_highs);
ipopt::load_library(lib_ipopt);
```

### 模型
```cpp
class MODEL_API KnitroModel : public ModelBase
{
public:
    KnitroModel();
    ~KnitroModel();
};

class MODEL_API HighsModel : public ModelBase
{
public:
	HighsModel();
    ~HighsModel();
};

class MODEL_API IpoptModel : public ModelBase
{
public:
	IpoptModel();
    ~IpoptModel();
};
示例：
KnitroModel model;
HighsModel model;
IpoptModel model;
```

### 添加变量
```cpp
VariableIndex add_variable(double lb, double ub, VariableDomain domain = VariableDomain::Continuous,
                               const char *name = nullptr) override;


示例：
VariableIndex x = model.add_variable(0, 1, VariableDomain::Continuous, "x");
```

### 添加线性约束
```cpp
ConstraintIndex add_linear_constraint(const ScalarAffineFunction &f, ConstraintSense sense, double rhs,
                                        const char *name = nullptr) override;

示例：
model.add_linear_constraint(5 * x1 + 3 * x2, ConstraintSense::LessEqual, 100.0, "c1");
```

### 添加二次约束
```cpp
ConstraintIndex add_quadratic_constraint(const ScalarQuadraticFunction &f,
                                            ConstraintSense sense, double rhs,
                                            const char *name = nullptr);

示例：
model.add_quadratic_constraint(x1 * x1 + 2 * x2 * x2, ConstraintSense::LessEqual, 100.0, "c2");
```

### 添加非线性约束
```cpp
    NLConstraintIndex add_nl_constraint(const ExpressionHandle &expr, ConstraintSense sense, double rhs,
                                        const char *name = nullptr);

示例：
{
    ExpressionGraphContextGuard guard1;
    auto expr1 = sin(x1 + x1 * x2);
    model.add_nl_constraint(expr1, ConstraintSense::LessEqual, 5.0, "nl_con1");
    auto expr2 = cos(x1 + x1 * x2);
    model.add_nl_constraint(expr2, ConstraintSense::LessEqual, 5.0, "nl_con1");
    auto expr3 = tan(x1 + x1 * x2);
    model.add_nl_constraint(expr3, ConstraintSense::LessEqual, 5.0, "nl_con1");
}
```

### 添加线性、二次目标函数
```cpp
void set_objective(const ExprBuilder &expr, ObjectiveSense sense);

示例：
model.set_objective(5 * x1 + 3 * x2, ObjectiveSense::Minimize);
```

### 添加非线性目标函数
```cpp
void add_nl_objective(const ExpressionHandle &expr);

示例：
{
	ExpressionGraphContextGuard guard_con1;
	//model.add_nl_objective( sin( x1 + x2 ) );
    
    // 使用变量和表达式运算时，可能需要使用expr()强转变量
	model.add_nl_objective(expr(x1) * x4 * (x1 + x2 + x3) + x3);
}
```

### 求解
```cpp
void optimize() override;


示例：
model.optimize();
```

### 获取结果
```cpp
double get_variable_value(const VariableIndex &variable) override;
double get_obj_value();

示例：
double x1_value = model.get_variable_value(x1);
double obj_value = model.get_obj_value();
```

### 获取变量上下界
```cpp
double get_variable_lb(const VariableIndex &variable);
double get_variable_ub(const VariableIndex &variable);
```

### 设置变量上下界
```cpp
void set_variable_lb(const VariableIndex &variable, double lb);
void set_variable_ub(const VariableIndex &variable, double ub);
void set_variable_bounds(const VariableIndex &variable, double lb, double ub) override;
```

### 获取变量初始值
```cpp
double get_variable_start(const VariableIndex &variable);
```

### 设置变量初始值
```cpp
void set_variable_start(const VariableIndex &variable, double start);
```

### 设置求解器属性
```cpp
// 通过属性名设置
void set_parameter(const char *name, double value) override;
void set_parameter(const char *name, int value) override;
void set_parameter(const char *name, const char *value) override;

// 通过属性ID设置
int set_option_int_by_code(const int &code, int value);
int set_option_double_by_code(const int &code, double value);
int set_option_string_by_code(const int &code, const std::string &value);
```