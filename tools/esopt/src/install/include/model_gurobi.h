#pragma once
#include "solvers/gurobi/gurobi_c.h"
#include "model_base.h"
#include "dylib.h"

#include <memory>

// define Gurobi C APIs
#define APILIST               \
	B(GRBnewmodel);           \
	B(GRBfreemodel);          \
	B(GRBreset);              \
	B(GRBgetenv);             \
	B(GRBwrite);              \
	B(GRBaddvar);             \
	B(GRBdelvars);            \
	B(GRBaddconstr);          \
	B(GRBaddqconstr);         \
	B(GRBaddsos);             \
	B(GRBaddgenconstrNL);     \
	B(GRBdelconstrs);         \
	B(GRBdelqconstrs);        \
	B(GRBdelsos);             \
	B(GRBdelgenconstrs);      \
	B(GRBdelq);               \
	B(GRBsetdblattrarray);    \
	B(GRBaddqpterms);         \
	B(GRBoptimize);           \
	B(GRBupdatemodel);        \
	B(GRBgetparamtype);       \
	B(GRBsetintparam);        \
	B(GRBsetdblparam);        \
	B(GRBsetstrparam);        \
	B(GRBgetintparam);        \
	B(GRBgetdblparam);        \
	B(GRBgetstrparam);        \
	B(GRBgetattrinfo);        \
	B(GRBsetintattr);         \
	B(GRBsetdblattr);         \
	B(GRBsetstrattr);         \
	B(GRBgetintattr);         \
	B(GRBgetdblattr);         \
	B(GRBgetstrattr);         \
	B(GRBgetdblattrarray);    \
	B(GRBgetdblattrlist);     \
	B(GRBsetdblattrlist);     \
	B(GRBsetintattrelement);  \
	B(GRBsetcharattrelement); \
	B(GRBsetdblattrelement);  \
	B(GRBsetstrattrelement);  \
	B(GRBgetintattrelement);  \
	B(GRBgetcharattrelement); \
	B(GRBgetdblattrelement);  \
	B(GRBgetstrattrelement);  \
	B(GRBgetcoeff);           \
	B(GRBchgcoeffs);          \
	B(GRBgeterrormsg);        \
	B(GRBversion);            \
	B(GRBsetcallbackfunc);    \
	B(GRBcbget);              \
	B(GRBcbproceed);          \
	B(GRBterminate);          \
	B(GRBcbsolution);         \
	B(GRBcblazy);             \
	B(GRBcbcut);              \
	B(GRBemptyenv);           \
	B(GRBloadenv);            \
	B(GRBfreeenv);            \
	B(GRBstartenv);           \
	B(GRBconverttofixed);     \
	B(GRBcomputeIIS);		\
	B(GRBreadmodel);

namespace gurobi
{
#define B DYLIB_EXTERN_DECLARE
	APILIST
#undef B

		bool is_library_loaded();

	MODEL_API bool load_library(const std::string& path);
} // namespace gurobi

class MODEL_API GurobiEnv
{
public:
	GurobiEnv(bool empty = false);
	~GurobiEnv();

	// parameter
	int raw_parameter_type(const char* param_name);
	void set_raw_parameter_int(const char* param_name, int value);
	void set_raw_parameter_double(const char* param_name, double value);
	void set_raw_parameter_string(const char* param_name, const char* value);

	void start();
	void close();

	void check_error(int error);

private:
	GRBenv* m_env = nullptr;

	friend class GurobiModel;
};

struct GRBfreemodelT
{
	void operator()(GRBmodel* model) const
	{
		gurobi::GRBfreemodel(model);
	};
};

class GurobiModel;
using GurobiCallback = std::function<void(GurobiModel*, int)>;

struct MODEL_API GurobiCallbackUserdata
{
	void* model = nullptr;
	GurobiCallback callback;
	int n_variables = 0;
	int where = 0;
	// store result of cbget
	bool cb_get_mipsol_called = false;
	std::vector<double> mipsol;
	bool cb_get_mipnoderel_called = false;
	std::vector<double> mipnoderel;
	// Cache for cbsolution
	bool cb_set_solution_called = false;
	std::vector<double> heuristic_solution;
	bool cb_requires_submit_solution = false;
};

class MODEL_API GurobiModel : public ModelBase
{
public:
	GurobiModel() = default;
	GurobiModel(const GurobiEnv& env);
	~GurobiModel() = default;

	void init(const GurobiEnv& env);
	void close();

	// 添加变量
	VariableIndex add_variable(double lb, double ub, VariableDomain domain = VariableDomain::Continuous,
	const char* name = nullptr) override;

	// 添加线性约束
	ConstraintIndex add_linear_constraint(const ScalarAffineFunction& f, ConstraintSense sense, double rhs,
	const char* name = nullptr) override;

	// 设置目标函数
	void set_objective(const ScalarAffineFunction& expr, ObjectiveSense sense = ObjectiveSense::Minimize) override;

	// 求解优化模型
	void optimize() override;

	// 设置变量上下界
	void set_variable_bounds(const VariableIndex& variable, double lb, double ub) override;
	// 获取变量值
	double get_variable_value(const VariableIndex& variable) override;

	// 获取和设置属性
	bool supports_model_attribute(ModelAttributeDouble attribute, bool changeable) override;
	bool supports_model_attribute(ModelAttributeInt attribute, bool changeable) override;
	bool supports_model_attribute(ModelAttributeString attribute, bool changeable) override;
	double get_model_attribute(ModelAttributeDouble attribute) override;
	int get_model_attribute(ModelAttributeInt attribute) override;
	std::string get_model_attribute(ModelAttributeString attribute) override;
	void set_model_attribute(ModelAttributeDouble attribute, double value) override;
	void set_model_attribute(ModelAttributeInt attribute, int value) override;
	void set_model_attribute(ModelAttributeString attribute, const char *value) override;
	
	// 变量和约束的属性的接口类似，待添加
	bool supports_variable_attribute(VariableAttributeDouble attribute, bool changeable) override;
	bool supports_variable_attribute(VariableAttributeInt attribute, bool changeable) override;
	bool supports_variable_attribute(VariableAttributeString attribute, bool changeable) override;
	double get_variable_attribute(const VariableIndex& variable, VariableAttributeDouble attribute) override;
	int get_variable_attribute(const VariableIndex& variable, VariableAttributeInt attribute) override;
	std::string get_variable_attribute(const VariableIndex& variable, VariableAttributeString attribute) override;
	void set_variable_attribute(const VariableIndex& variable, VariableAttributeDouble attribute, double value) override;
	void set_variable_attribute(const VariableIndex& variable, VariableAttributeInt attribute, int value) override;
	void set_variable_attribute(const VariableIndex& variable, VariableAttributeString attribute, const char *value) override;
	void set_variable_attribute(const VariableIndex &variable, VariableAttributeString attribute, VariableDomain& domain);
	
	bool supports_constraint_attribute(ConstraintAttributeDouble attribute, bool changeable) override;
	bool supports_constraint_attribute(ConstraintAttributeInt attribute, bool changeable) override;
	bool supports_constraint_attribute(ConstraintAttributeString attribute, bool changeable) override;
	double get_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeDouble attribute) override;
	int get_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeInt attribute) override;
	std::string get_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeString attribute) override;
	void set_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeDouble attribute, double value) override;
	void set_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeInt attribute, int value) override;
	void set_constraint_attribute(const ConstraintIndex& constraint, ConstraintAttributeString attribute, const char *value) override;
	
	// 设置求解器参数
	void set_parameter(const char* name, double value) override;
	void set_parameter(const char* name, int value) override;
	void set_parameter(const char* name, const char* value) override;


	// Non-exported functions
	void check_error(int error);
	void update();
	// Callback
	void set_callback(const GurobiCallback& callback);

	// For callback
	bool has_callback = false;
	void* m_cbdata = nullptr;
	GurobiCallbackUserdata m_callback_userdata;

	int cb_get_info_int(int what);
	double cb_get_info_double(int what);
	void cb_get_info_doublearray(int what);

	double cb_get_solution(const VariableIndex& variable);
	double cb_get_relaxation(const VariableIndex& variable);
	void cb_set_solution(const VariableIndex& variable, double value);
	double cb_submit_solution();

	void cb_exit();

	void cb_add_lazy_constraint(const ScalarAffineFunction& function, ConstraintSense sense,
		CoeffT rhs);
	void cb_add_lazy_constraint(const ExprBuilder& function, ConstraintSense sense, CoeffT rhs);
	void cb_add_user_cut(const ScalarAffineFunction& function, ConstraintSense sense, CoeffT rhs);
	void cb_add_user_cut(const ExprBuilder& function, ConstraintSense sense, CoeffT rhs);

	int _variable_index(const VariableIndex &variable);
private:
	void _set_affine_objective(const ScalarAffineFunction& function, ObjectiveSense sense,
		bool clear_quadratic);
	int _checked_variable_index(const VariableIndex &variable);
	void _update_for_information();

	// 模型获取和设置参数
	int    get_model_raw_attribute_int(const char* attr_name);
	double get_model_raw_attribute_double(const char* attr_name);
	std::string get_model_raw_attribute_string(const char* attr_name);
	
	void set_model_raw_attribute_int(const char *attr_name, int value);
	void set_model_raw_attribute_double(const char *attr_name, double value);
	void set_model_raw_attribute_string(const char *attr_name, const char *value);
	
	// 变量获取和设置参数
	double get_variable_raw_attribute_double(const VariableIndex& variable, const char* attr_name);
	int    get_variable_raw_attribute_int(const VariableIndex& variable, const char* attr_name);
	std::string get_variable_raw_attribute_string(const VariableIndex& variable, const char* attr_name);
	char get_variable_raw_attribute_char(const VariableIndex &variable,
                                                  const char *attr_name);
	void set_variable_raw_attribute_int(const VariableIndex& variable, const char* attr_name, int value);
	void set_variable_raw_attribute_double(const VariableIndex& variable, const char* attr_name, double value);
	void set_variable_raw_attribute_string(const VariableIndex& variable, const char* attr_name, const char* value);
	void set_variable_raw_attribute_char(const VariableIndex &variable,
                                                  const char *attr_name, char value);

	// 约束获取和设置参数
	double get_constraint_raw_attribute_double(const ConstraintIndex& constraint, const char* attr_name);
	int    get_constraint_raw_attribute_int(const ConstraintIndex& constraint, const char* attr_name);
	std::string get_constraint_raw_attribute_string(const ConstraintIndex& constraint, const char* attr_name);
	
	void set_constraint_raw_attribute_int(const ConstraintIndex& constraint, const char* attr_name, int value);
	void set_constraint_raw_attribute_double(const ConstraintIndex& constraint, const char* attr_name, double value);
	
	void set_constraint_raw_attribute_string(const ConstraintIndex& constraint, const char* attr_name, const char* value);
private:
    class Impl;
    std::unique_ptr<Impl> pImpl;

	size_t m_n_variables = 0;
	size_t m_n_linear_cons = 0;
	std::uint64_t m_update_flag = 0;

	/* flag to indicate whether the model needs update */
	enum : std::uint64_t
	{
		m_variable_creation = 1,
		m_variable_deletion = 1 << 1,
		m_linear_constraint_creation = 1 << 2,
		m_linear_constraint_deletion = 1 << 3,
		m_quadratic_constraint_creation = 1 << 4,
		m_quadratic_constraint_deletion = 1 << 5,
		m_sos_constraint_creation = 1 << 6,
		m_sos_constraint_deletion = 1 << 7,
		m_general_constraint_creation = 1 << 8,
		m_general_constraint_deletion = 1 << 9,
		m_objective_update = 1 << 10,
		m_attribute_update = 1 << 11,
		m_constraint_coefficient_update = 1 << 12,
	};


	/* Gurobi part */
	GRBenv* m_env = nullptr;
	std::unique_ptr<GRBmodel, GRBfreemodelT> m_model;
};
