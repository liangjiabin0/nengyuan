#pragma once
#include "solvers/cplex/ilcplex/cplex.h"
#include "model_base.h"
#include "dylib.h"

#include <memory>

// define Gurobi C APIs
#define APILIST               \
	B(CPXcreateprob);           \
	B(CPXfreeprob);          \
	B(CPXopenCPLEX);		 \
	B(CPXcloseCPLEX);		 \
	B(CPXchgprobtype);			\
	B(CPXchgprobname);			\
	B(CPXnewcols);			\
	B(CPXaddcols);             \
	B(CPXdelcols);            \
	B(CPXnewrows);            \
	B(CPXaddrows);          \
	B(CPXchgname);			\
	B(CPXgetcolname);			\
	B(CPXaddqconstr);         \
	B(CPXaddsos);             \
	B(CPXdelrows);         \
	B(CPXdelqconstrs);        \
	B(CPXdelsos);             \
	B(CPXgetparamtype);       \
	B(CPXsetintparam);        \
	B(CPXsetlongparam);			\
	B(CPXsetdblparam);        \
	B(CPXsetstrparam);        \
	B(CPXgetintparam);        \
	B(CPXgetlongparam);        \
	B(CPXgetdblparam);        \
	B(CPXgetstrparam);        \
	B(CPXgetparamname);       \
	B(CPXinfodblparam);      \
	B(CPXgetlb);           \
	B(CPXgetub);           \
	B(CPXgetcoef);           \
    B(CPXchgcoef);           \
	B(CPXchgobj);           \
	B(CPXchgobjoffset);           \
	B(CPXchgobjsen);		\
	B(CPXchgctype);           \
	B(CPXchgbds);           \
	B(CPXgetctype);           \
	B(CPXgeterrorstring);    \
	B(CPXversion);            \
    B(CPXmipopt);			\
	B(CPXlpopt);			\
	B(CPXsolution);

namespace cplex
{
#define B DYLIB_EXTERN_DECLARE
	APILIST
#undef B

		bool is_library_loaded();

	MODEL_API bool load_library(const std::string& path);
} // namespace cplex

class CplexModel;

class MODEL_API CplexEnv
{
public:
	CplexEnv();
	~CplexEnv();

	// parameter
	int raw_parameter_type(const int param);
	void set_raw_parameter_int(const int param, int value);
	void set_raw_parameter_double(const int param, double value);
	void set_raw_parameter_string(const int param, const char* value);

	// void start();
	void close();

	void check_error(int error);

private:
	CPXENVptr m_env = nullptr;

	friend class CplexModel;
};

struct CPXfreemodelT
{
	CPXENVptr m_env;
	void operator()(CPXLPptr model) const
	{
		cplex::CPXfreeprob(m_env, &model);
	};
};


class MODEL_API CplexModel : public ModelBase
{
public:
	CplexModel() = default;
	CplexModel(const CplexEnv& env);
	~CplexModel();

	void init(const CplexEnv& env);
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
	void set_parameter(const int  whichparm, double value);
	void set_parameter(const int  whichparm, int value);
	void set_parameter(const int  whichparm, long long value);
	void set_parameter(const int  whichparm, const char* value);



	// Non-exported functions
	void check_error(int error);

	int _variable_index(const VariableIndex &variable);
private:
	void _set_affine_objective(const ScalarAffineFunction& function, ObjectiveSense sense,
		bool clear_quadratic);
	int _checked_variable_index(const VariableIndex &variable);

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
	std::vector<double> starts;

	/* Cplex part */
	int is_mip = 0;
	CPXENVptr m_env = nullptr;
	std::unique_ptr<cpxlp, CPXfreemodelT> m_model;
};
