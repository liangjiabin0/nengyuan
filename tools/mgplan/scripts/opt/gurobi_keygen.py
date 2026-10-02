def transform_and_assign(value):
    """ Transform the value and assign the corresponding character. """
    if value >= 26:
        return chr((value + 22) % 256)  # Modulo 256 to keep within valid ASCII range
    else:
        return chr((value + 65) % 256)

def encode_key(a1):
    MOD = 2**32  # Emulating 32-bit integer overflow

    v2 = (1626578507 * a1 + 240116140) % MOD
    v3 = (1683521 * v2 + 2737) % MOD
    v4 = v3 // 0x24
    v5 = v3 % 0x24
    a2 = [transform_and_assign(v5)]

    v7 = v4 // 0x24
    v8 = v4 % 0x24
    a2.append(transform_and_assign(v8))

    v10 = v7 - 9 * ((v7 // 9) & 0xFFFFFFFC)
    a2.append(transform_and_assign(v10))

    v12 = v7 // 0x24 - 9 * ((v7 // 0x24 // 9) & 0xFFFFFFFC)
    a2.append(transform_and_assign(v12))

    v14 = v2 // 0x24
    v15 = v2 % 0x24
    a2.append(transform_and_assign(v15))

    v17 = v14 // 0x24
    v18 = v14 % 0x24
    a2.append(transform_and_assign(v18))

    v20 = v17 - 9 * ((v17 // 9) & 0xFFFFFFFC)
    a2.append(transform_and_assign(v20))

    result = 954437177 * (v17 // 0x24) % MOD
    v23 = v17 // 0x24 - 9 * ((v17 // 0x24 // 9) & 0xFFFFFFFC)
    a2.append(transform_and_assign(v23))

    return ''.join(a2)

def compute_magicnumber(oem:str, app:str):
    v1 = sum(ord(c) for c in oem)
    v2 = sum(ord(c) for c in app)
    v3 = 13 * v1 + 31 * v2 + 36
    return v3

# Execute the function with a1 = 54778
# result = "DCVWS8BA"
def poc():
    magic_number = compute_magicnumber("AMPL", "AMPL (+distributed)")
    key = encode_key(magic_number)
    assert key == "DCVWS8BA"
