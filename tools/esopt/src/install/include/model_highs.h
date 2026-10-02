#pragma once
#include "highs_c_api.h"

#include "model_base.h"
#include "dylib.h"

#include <memory>

#define APILIST                     \
	B(Highs_create);                \
	B(Highs_destroy);               \
	B(Highs_writeModel);            \
	B(Highs_writeSolution);         \
	B(Highs_writeSolutionPretty);   \
	B(Highs_addCol);                \
	B(Highs_addCols);               \
	B(Highs_passColName);           \
	B(Highs_getColName);            \
	B(Highs_getNumCol);             \
	B(Highs_changeColIntegrality);  \
	B(Highs_deleteColsBySet);       \
	B(Highs_addRow);                \
	B(Highs_addRows);               \
	B(Highs_passRowName);           \
	B(Highs_getRowName);            \
	B(Highs_getNumRow);             \
	B(Highs_deleteRowsBySet);       \
	B(Highs_passHessian);           \
	B(Highs_changeColsCostByRange); \
	B(Highs_changeObjectiveOffset); \
	B(Highs_changeObjectiveSense);  \
	B(Highs_run);                   \
	B(Highs_getModelStatus);        \
	B(Highs_getDualRay);            \
	B(Highs_getPrimalRay);          \
	B(Highs_getIntInfoValue);       \
	B(Highs_getSolution);           \
	B(Highs_getHessianNumNz);       \
	B(Highs_getBasis);              \
	B(Highs_version);               \
	B(Highs_getRunTime);            \
	B(Highs_getOptionType);         \
	B(Highs_setBoolOptionValue);    \
	B(Highs_setIntOptionValue);     \
	B(Highs_setDoubleOptionValue);  \
	B(Highs_setStringOptionValue);  \
	B(Highs_getBoolOptionValue);    \
	B(Highs_getIntOptionValue);     \
	B(Highs_getDoubleOptionValue);  \
	B(Highs_getStringOptionValue);  \
	B(Highs_getInfoType);           \
	B(Highs_getInt64InfoValue);     \
	B(Highs_getDoubleInfoValue);    \
	B(Highs_getColIntegrality);     \
	B(Highs_changeColsBoundsBySet); \
	B(Highs_getColsBySet);          \
	B(Highs_getObjectiveSense);     \
	B(Highs_getObjectiveValue);     \
	B(Highs_getColsByRange);        \
	B(Highs_setSolution);           \
	B(Highs_getRowsBySet);          \
	B(Highs_changeRowsBoundsBySet); \
	B(Highs_changeCoeff);           \
	B(Highs_changeColCost);			\
	B(Highs_getNumNz);				\
	B(Highs_getObjectiveOffset);	\
	B(Highs_getRowsByRange);		\
	B(Highs_clearModel);			\
	B(Highs_readModel);

    namespace highs
{
#define B DYLIB_EXTERN_DECLARE
APILIST
#undef B

bool is_library_loaded();

bool MODEL_API load_library(const std::string &path);
} // namespace highs

struct HighsfreemodelT
{
	void operator()(void *model) const
	{
		highs::Highs_destroy(model);
	};
};

class MODEL_API HighsModel : public ModelBase
{
public:
	HighsModel();
    ~HighsModel();

	void init();
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
	
	// 变量和约束的属性的接口
	bool supports_variable_attribute(VariableAttributeDouble attribute, bool changeable) override;
	bool supports_variable_attribute(VariableAttributeInt attribute, bool changeable) override;
	bool supports_variable_attribute(VariableAttributeString attribute, bool changeable) override;
	double get_variable_attribute(const VariableIndex& variable, VariableAttributeDouble attribute) override;
	int get_variable_attribute(const VariableIndex& variable, VariableAttributeInt attribute) override;
	std::string get_variable_attribute(const VariableIndex& variable, VariableAttributeString attribute) override;
	void set_variable_attribute(const VariableIndex& variable, VariableAttributeDouble attribute, double value) override;
	void set_variable_attribute(const VariableIndex& variable, VariableAttributeInt attribute, int value) override;
	void set_variable_attribute(const VariableIndex& variable, VariableAttributeString attribute, const char *value) override;
	void set_variable_attribute(const VariableIndex &variable, VariableAttributeString attribute, VariableDomain domain);
	
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
    void set_parameter(const char* name, bool value);

    
	std::string get_variable_name(const VariableIndex &variable);
	void set_variable_name(const VariableIndex &variable, const char *name);
	VariableDomain get_variable_type(const VariableIndex &variable);
	void set_variable_type(const VariableIndex &variable, VariableDomain domain);
	double get_variable_lower_bound(const VariableIndex &variable);
	double get_variable_upper_bound(const VariableIndex &variable);
	void set_variable_lower_bound(const VariableIndex &variable, double lb);
	void set_variable_upper_bound(const VariableIndex &variable, double ub);
	void set_primal_start(const Vector<VariableIndex> &variables,
    const Vector<double> &values);
    std::string get_constraint_name(const ConstraintIndex &constraint);
    void set_constraint_name(const ConstraintIndex &constraint, const char *name);
    double get_constraint_primal(const ConstraintIndex &constraint);
    double get_constraint_dual(const ConstraintIndex &constraint);
    
    ObjectiveSense get_obj_sense();
    void set_obj_sense(ObjectiveSense sense);
    double get_obj_value();
        
    int _variable_index(const VariableIndex &variable);
	HighsInt _constraint_index(const ConstraintIndex &constraint);
	HighsInt _checked_constraint_index(const ConstraintIndex &constraint);
private:
	int _checked_variable_index(const VariableIndex &variable);

	void _set_affine_objective(const ScalarAffineFunction& function, ObjectiveSense sense,
		bool clear_quadratic);
private:
    class Impl;
    std::unique_ptr<Impl> pImpl;

	size_t m_n_variables = 0;
	size_t m_n_linear_cons = 0;

    std::unique_ptr<void, HighsfreemodelT> m_model;
};
