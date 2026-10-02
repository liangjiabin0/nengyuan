#pragma once

#include <ostream>
#include "cppad/cppad.hpp"
#include "nlexpr.hpp"
#include "nleval.hpp"

struct GenerateCsrcOptions
{
	size_t np = 0;
	bool hessian_lagrange = false;
	size_t nw = 0;
	bool indirect_x = false;
	bool indirect_p = false;
	bool indirect_w = false;
	bool indirect_y = false;
	bool add_y = false;
};

void generate_csrc_prelude(std::ostream &io);

void generate_csrc_from_graph(
	std::ostream &io,
	CppAD::cpp_graph &graph_obj,
	const std::string &name,
	const GenerateCsrcOptions &options = GenerateCsrcOptions{});