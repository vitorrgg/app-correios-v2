const logger = require('firebase-functions/logger')
const { calculate } = require('../../../lib/correios-calculate')

exports.post = async ({ appSdk }, req, res) => {
  const { params, application } = req.body
  const { storeId } = req
  // setup basic required response object
  const response = {
    shipping_services: []
  }
  // merge all app options configured by merchant
  const appData = Object.assign({}, application.data, application.hidden_data)

  if (appData.free_shipping_from_value >= 0) {
    response.free_shipping_from_value = appData.free_shipping_from_value
  }
  if (!params.to) {
    // just a free shipping preview with no shipping address received
    // respond only with free shipping option
    res.send(response)
    return
  }

  const cepDestino = params.to ? params.to.zip.replace(/\D/g, '') : ''
  const cepOrigem = params.from
    ? params.from.zip.replace(/\D/g, '')
    : appData.zip ? appData.zip.replace(/\D/g, '') : ''
  if (!cepOrigem) {
    // must have configured origin zip code to continue
    return res.status(409).send({
      error: 'CALCULATE_ERR',
      message: 'Zip code is unset on app hidden data (merchant must configure the app)'
    })
  }
  if (!params.items) {
    return res.status(400).send({
      error: 'CALCULATE_EMPTY_CART',
      message: 'Cannot calculate shipping without cart items'
    })
  }

  const checkZipCode = rule => {
    // validate rule zip range
    if (cepDestino && rule.zip_range) {
      const { min, max } = rule.zip_range
      return Boolean((!min || cepDestino >= min) && (!max || cepDestino <= max))
    }
    return true
  }

  // search for configured free shipping rule
  if (Array.isArray(appData.shipping_rules)) {
    for (let i = 0; i < appData.shipping_rules.length; i++) {
      const rule = appData.shipping_rules[i]
      if (rule.free_shipping && checkZipCode(rule)) {
        if (!rule.min_amount) {
          response.free_shipping_from_value = 0
          break
        } else if (!(response.free_shipping_from_value <= rule.min_amount)) {
          response.free_shipping_from_value = rule.min_amount
        }
      }
    }
  }

  // optinal predefined or configured service codes
  let serviceCodes
  if (params.service_code) {
    serviceCodes = [params.service_code]
  } else if (appData.services?.[0]?.service_code) {
    serviceCodes = appData.services.map((service) => service.service_code)
  }

  // optional params to Correios services
  let vlDeclarado = 0
  const servicosAdicionais = []
  if (params.subtotal && !appData.no_declare_value) {
    vlDeclarado = params.subtotal
  }
  // https://api.correios.com.br/preco/v1/servicos-adicionais/03220
  if (params.own_hand) {
    servicosAdicionais.push('002')
  }
  if (params.receipt) {
    servicosAdicionais.push('001')
  }

  // calculate weight and pkg value from items list
  let nextDimensionToSum = 'length'
  const pkg = {
    dimensions: {
      width: {
        value: 0,
        unit: 'cm'
      },
      height: {
        value: 0,
        unit: 'cm'
      },
      length: {
        value: 0,
        unit: 'cm'
      }
    },
    weight: {
      value: 0,
      unit: 'g'
    }
  }

  params.items.forEach(({ price, quantity, dimensions, weight }) => {
    if (!params.subtotal && !appData.no_declare_value) {
      vlDeclarado += price * quantity
    }
    // sum physical weight
    if (weight && weight.value) {
      let weightValue
      switch (weight.unit) {
        case 'kg':
          weightValue = weight.value * 1000
          break
        case 'g':
          weightValue = weight.value
          break
        case 'mg':
          weightValue = weight.value / 1000000
        default:
          weightValue = weight.value
      }
      if (weightValue) {
        pkg.weight.value += weightValue * quantity
      }
    }

    // sum total items dimensions to calculate cubic weight
    if (dimensions) {
      for (const side in dimensions) {
        const dimension = dimensions[side]
        if (dimension && dimension.value) {
          let dimensionValue
          switch (dimension.unit) {
            case 'cm':
              dimensionValue = dimension.value
              break
            case 'm':
              dimensionValue = dimension.value * 100
              break
            case 'mm':
              dimensionValue = dimension.value / 10
            default:
              dimensionValue = dimension.value
          }
          // add/sum current side to final dimensions object
          if (dimensionValue) {
            const pkgDimension = pkg.dimensions[side]
            if (appData.use_bigger_box === true) {
              if (!pkgDimension.value || pkgDimension.value < dimensionValue) {
                pkgDimension.value = dimensionValue
              }
            } else {
              for (let i = 0; i < quantity; i++) {
                if (!pkgDimension.value) {
                  pkgDimension.value = dimensionValue
                } else if (nextDimensionToSum === side) {
                  pkgDimension.value += dimensionValue
                  nextDimensionToSum = nextDimensionToSum === 'length'
                    ? 'width'
                    : nextDimensionToSum === 'width' ? 'height' : 'length'
                } else if (pkgDimension.value < dimensionValue) {
                  pkgDimension.value = dimensionValue
                }
              }
            }
          }
        }
      }
    }
  })

  let correiosResult
  if (storeId == 51466) {
      console.log('send item', JSON.stringify({
          psObjeto: pkg.weight.value,
          comprimento: pkg.dimensions.length.value,
          altura: pkg.dimensions.height.value,
          largura: pkg.dimensions.width.value,
          vlDeclarado,
          servicosAdicionais
        }))
  }
  try {
    const { data } = await calculate({
      correiosParams: {
        cepOrigem,
        cepDestino,
        psObjeto: pkg.weight.value,
        comprimento: pkg.dimensions.length.value,
        altura: pkg.dimensions.height.value,
        largura: pkg.dimensions.width.value,
        vlDeclarado,
        servicosAdicionais
      },
      serviceCodes,
      storeId
    })
    correiosResult = data
  } catch (err) {
    const { response } = err
    return res.status(409).send({
      error: 'CALCULATE_FAILED',
      message: response?.data?.[0]?.txErro || err.message
    })
  }

  correiosResult.forEach(({
    coProduto,
    // psCobrado
    // peAdValorem
    pcProduto,
    pcTotalServicosAdicionais,
    pcFinal,
    prazoEntrega,
    entregaSabado,
    txErro
  }) => {
    if (txErro) {
      logger.warn(`[calculate] alert/error with #${storeId} ${coProduto}`, {
        pcFinal,
        prazoEntrega,
        txErro
      })
    }
    if (!pcFinal || !(prazoEntrega >= 0)) {
      return
    }
    // find respective configured service label
    let serviceName
    switch (coProduto) {
      case '04014':
      case '03220':
      case '03204':
        serviceName = 'SEDEX'
        break
      case '04510':
      case '03298':
        serviceName = 'PAC'
    }
    let label = serviceName || `Correios ${coProduto}`
    if (Array.isArray(appData.services)) {
      for (let i = 0; i < appData.services.length; i++) {
        const service = appData.services[i]
        if (service && service.service_code === coProduto && service.label) {
          label = service.label
        }
      }
    }

    // parse to E-Com Plus shipping line object
    const parseMoney = (str) => (Number(str.replace(',', '.') || 0))
    const shippingLine = {
      from: {
        ...params.from,
        zip: cepOrigem
      },
      to: params.to,
      package: pkg,
      price: parseMoney(pcProduto || pcFinal),
      declared_value: pcTotalServicosAdicionais ? vlDeclarado : 0,
      declared_value_price: pcTotalServicosAdicionais ? parseMoney(pcTotalServicosAdicionais) : 0,
      own_hand: Boolean(params.own_hand),
      receipt: Boolean(params.receipt),
      discount: 0,
      total_price: parseMoney(pcFinal),
      delivery_time: {
        days: Number(prazoEntrega),
        working_days: entregaSabado !== 'S'
      },
      posting_deadline: {
        days: 3,
        ...appData.posting_deadline
      },
      flags: ['correios-api']
    }

    // check for default configured additional/discount price
    if (typeof appData.additional_price === 'number' && appData.additional_price) {
      if (appData.additional_price > 0) {
        shippingLine.other_additionals = [{
          tag: 'additional_price',
          label: 'Adicional padrão',
          price: appData.additional_price
        }]
      } else {
        // negative additional price to apply discount
        shippingLine.discount -= appData.additional_price
      }
      // update total price
      shippingLine.total_price += appData.additional_price
    }

    // search for discount by shipping rule
    if (Array.isArray(appData.shipping_rules)) {
      for (let i = 0; i < appData.shipping_rules.length; i++) {
        const rule = appData.shipping_rules[i]
        if (
          rule &&
          (!rule.service_code || rule.service_code === coProduto) &&
          checkZipCode(rule) &&
          !(rule.min_amount > params.subtotal)
        ) {
          // valid shipping rule
          if (rule.free_shipping) {
            shippingLine.discount += shippingLine.total_price
            shippingLine.total_price = 0
            break
          } else if (rule.discount) {
            let discountValue = rule.discount.value
            if (rule.discount.percentage) {
              discountValue *= (shippingLine.total_price / 100)
            }
            if (discountValue) {
              shippingLine.discount += discountValue
              shippingLine.total_price -= discountValue
              if (shippingLine.total_price < 0) {
                shippingLine.total_price = 0
              }
            }
            break
          }
        }
      }
    }

    // push shipping service object to response
    response.shipping_services.push({
      label,
      carrier: 'Correios',
      // https://informederendimentos.com/consulta/cnpj-correios/
      carrier_doc_number: '34704060000107',
      service_code: coProduto,
      service_name: serviceName || label,
      shipping_line: shippingLine
    })
  })

  res.send(response)
}
