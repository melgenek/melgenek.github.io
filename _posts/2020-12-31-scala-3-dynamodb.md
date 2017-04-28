---
layout: post
title: Enhancing DynamoDb client with Scala 3 
summary: "After 8 years of development, Dotty is going to become Scala 3 soon.
It's the right time to try out Scala 3 and its new features. In this article, I am going to show
a practical example of making DynamoDb Java client more type-safe and convenient using macros, type class derivations, 
extension methods, and a handful of implicits."
---


After 8 years of development, Dotty is going to become Scala 3 soon.
It's the right time to try out Scala 3 and its new features. In this article, I am going to show
a practical example of making DynamoDb more type-safe and convenient using [macros](https://dotty.epfl.ch/docs/reference/metaprogramming/macros.html),
[type class derivations](https://dotty.epfl.ch/docs/reference/contextual/derivation.html), [extensions methods](https://dotty.epfl.ch/docs/reference/contextual/extension-methods.html), 
and a handful of implicits.

<nav>
  <h4>Table of Contents</h4>
  * TOC
  {:toc}
</nav>



Introduction
-------------------
To start with, let's look at how to put and get an item from DynamoDb utilizing the plain aws-sdk client. 
The examples assume that there is a case class:
```scala
case class NewYear(year: Int, wish: String) {
  def gift: String = "A fairy pony"
}

val year = NewYear(2020, "I wish Scala 3 was released soon")
```
The case class is defined in the file `NewYear.scala`. The instance of the case class `val year=...` as well as the case class itself are [at the top-level](https://dotty.epfl.ch/docs/reference/dropped-features/package-objects.html) as well.
This is the first notable feature of Scala 3: the package objects were removed from the language. The values and methods don't need to be defined inside an object or class anymore.  

The instances of `NewYear` are going to be stored in the dynamo table `new-years`. 
I am omitting the code of creating the dynamo table, the whole example can be found in the [github repository](https://github.com/melgenek/dotty-dynamodb).  

Now we know the entities that are going to be stored in the database. We can take a look at the put/get code:
```scala
ddb.putItem(
  PutItemRequest.builder()
    .tableName(TableName)
    .item(Map(
      "year" -> AttributeValue.builder().n(year.year.toString).build(),
      "wish" -> AttributeValue.builder().s(year.wish).build()
    ).asJava)
    .build()
)

val item = ddb.getItem(
  GetItemRequest.builder()
    .tableName(TableName)
    .key(Map(
      "year" -> AttributeValue.builder().n("2020").build()
    ).asJava)
    .build()
)
```

What problems can we see here? 

Firstly, the `AttributeValues` are being built explicitly, the `year` of type `Int` is transformed into a `String` in order to be set as the value of the attribute.
Not only we can make a mistake of choosing the DynamoDb type by confusing the `.n` and `.s` value setters on the builder, but also the code looks ugly and verbose.
It's a great use case for type classes to provide a unified way of converting scala types to the `  AttributeValue`.

Secondly, the attribute names are passed as strings. The key of our table is `year`. 
A typo in the key of the get request can lead to no results being returned. 
You can argue that having constants for the attribute names is enough. 
However, keeping the same name of the key in the item map and the case class field is going to be crucial to write cases classes in the `.item` without an explicit construction of the map.

Here comes the last issue that we'll try solving in this article. The `.item` ignores the instance of the class that we defined and expects a map.
This case class has only 2 fields, so building a map is quite an easy task. Having 20 fields will definitely be error-prone 
because an additional field in the case class requires an additional line inside the `.item` map.

After making some improvements employing the features of Scala 3, we can get a neat code like this
```scala
ddb.putItem(
  PutItemRequest.builder()
    .tableName(TableName)
    .item(year)
    .build()
)

val item = ddb.getItem(
  GetItemRequest.builder()
    .tableName(TableName)
    .key[NewYear](_.year, 2021)
    .build()
)
```

In the following sections, I'll explain how to create the utilities for the code above to work. 

Encoding attributes. Implicits
-------------------

I'm going to introduce the improvements step by step. To start with, we'll make the attribute building more pleasant.
In order to do this, we'll have [a type class](https://dotty.epfl.ch/docs/reference/contextual/type-classes.html) for the conversion of a scala type to the `AttributeValue` and back. 
Every type that can be converted to the `AttributeValue` will have an implementation of the `AttributeCodec` trait:
```scala
trait AttributeCodec[A] {
  def encode(a: A): AttributeValue
  def decode(a: AttributeValue): A
}

given AttributeCodec[String] with {
  def encode(a: String): AttributeValue = AttributeValue.builder().s(a).build()
  def decode(a: AttributeValue): String = a.s()
}

implicit val intCodec: AttributeCodec[Int] = new AttributeCodec[Int] {
  def encode(a: Int): AttributeValue = AttributeValue.builder().n(a.toString).build()
  def decode(a: AttributeValue): Int = a.n().toInt
}
```
You can see that I defined two instances:
- the instance for the `String` type is defined with Scala 3 syntax
- the instance for the `Int` uses the old Scala 2 syntax

The Scala 3 syntax is slightly nicer, the instance names can be omitted. They are never used after all, 
because the instances are found in the implicit scope via summoning. In the new Scala, the method `implicitly`
is renamed to be `summon`:
```scala
summon[AttributeCodec[Int]].encode(2021) // AttributeValue.builder().n(2021.toString).build()
```

We can make the encoding look even better by adding a so-called "summoner" method to the `AttributeCodec`. 
There is a new keyword `using` that marks the implicit function parameters. It replaces the old `implicit`: 
```scala
object AttributeCodec {
  def apply[A](using codec: AttributeCodec[A]): AttributeCodec[A] = codec
  
  // The old syntax
  // def apply[A](implicit codec: AttributeCodec[A]): AttributeCodec[A] = codec
}
```

After this first round of enhancements our application is in the following state:
```scala
ddb.putItem(
  PutItemRequest.builder()
    .tableName(TableName)
    .item(Map(
      "year" -> AttributeCodec[Int].encode(year.year),
      "wish" -> AttributeCodec[String].encode(year.wish)
    ).asJava)
    .build()
)

val item = ddb.getItem(
  GetItemRequest.builder()
    .tableName(TableName)
    .key(Map(
      "year" -> AttributeCodec[Int].encode(2021)
    ).asJava)
    .build()
)
```

Obtaining class field names. Macros
-------------------

Our next step is the derivation of the attribute names based on the case class field names.
When we complete implementing this macro, the code will use fields instead of strings.
```scala
ddb.putItem(
  PutItemRequest.builder()
    .tableName(TableName)
    .item(Map(
      FieldName[NewYear](_.year) -> AttributeCodec[Int].encode(year.year),
      FieldName[NewYear](_.wish) -> AttributeCodec[String].encode(year.wish)
    ).asJava)
    .build()
)

val item = ddb.getItem(
  GetItemRequest.builder()
    .tableName(TableName)
    .key(Map(
      FieldName[NewYear](_.year) -> AttributeCodec[Int].encode(2021)
    ).asJava)
    .build()
)
```

As you can see the attribute name is defined via the accessor of the field `FieldName[NewYear](_.year)`. 
The automatic acquisition of the field name is performed with a [macro](https://dotty.epfl.ch/docs/reference/metaprogramming/macros.html):
```scala
inline def apply[T](inline f: T => Any): String = ${getName('f)}
```

This is an `apply` method that is defined with the modifier [inline](https://dotty.epfl.ch/docs/reference/metaprogramming/inline.html) and calls the macro implementation `getName`.
The methods that are implemented via macros are always required to be defined with the `inline` modifier. 
The second `inline` modifier on the parameter is optional. Let's look at a simple example to understand why it's needed in this situation.
The following code prints the parameter that is passed to the method:
```scala
import scala.quoted._
object InlineFunctions {
  inline def showExpr(expr: Any): String = ${showExprImpl('expr)}

  inline def showExprInlined(inline expr: Any): String = ${showExprImpl('expr)}

  private def showExprImpl(expr: Expr[Any])(using Quotes): Expr[String] =
    '{ ${Expr(expr.show)} + " = " + $expr }
}
```

The implementation of the macro is defined in the method `showExprImpl`. The first parameter has the type `Expr`. 
This type represents the abstract syntax tree for all the constructs that compose our code. For example, it's subtype `Literal` represents a single value, and the subtype `Block` contains multiple statements.
The `${expr}` is the same as `$expr`. It's called "splicing" and calculates the value of an expression. For example, the `${Expr("hello")}` is just the string `hello`.
The transformation can be reversed with the use of quotes `'{expr}` which is the same as `'expr`. Thus `'{"hello"}` is equal to `Expr("hello")`.
In essence the `showExprImpl` prints the string representation of the expression and its value using the splices and quotes. The `Quotes` context parameter contains some low-level operations and is used implicitly by these operations.
I defined 2 different functions: one with the `inline` parameter and another one without it. Let's call them and see the output.
```scala
import InlineFunctions._

object InlineMain extends App {
  val a = 1
  val b = 2

  println(showExprInlined(a + b))  //  demo.inline.InlineMain.a.+(demo.inline.InlineMain.b) = 3
  println(showExpr(a + b))  // expr$proxy2 = 3
}
```

The value of the sum operation is the same. The expressions that are passed to our macro are different though.
The `inline` modifier preserves the original expression. That's exactly what we need in order to get the field name from the function such as `(w:NewYear) => w.year`.

After we had a quick look at the `inline` modifier, splices, and quotes, it's time to move on and implement the `getName` method.
```scala
private def getName[T](f: Expr[T => Any])(using Type[T], Quotes): Expr[String] = {
  import quotes.reflect._
  val acc = new TreeAccumulator[String] {
    def foldTree(names: String, tree: Tree)(owner: Symbol): String = tree match {
      case Select(_, name) => name
      case _ => foldOverTree(names, tree)(owner)
    }
  }
  val fieldName = acc.foldTree(null, f.asTerm)(Symbol.spliceOwner)
  Expr(fieldName)
}
```

In the implementation, we dived even deeper into the Scala magic by calling `f.asTerm` so as to get access to the AST that the compiler sees.
This is so-called [TASTy Reflect](https://dotty.epfl.ch/docs/reference/metaprogramming/tasty-reflect.html). It provides an even more comprehensive view of the structure of the code. 
The power comes with a cost. Using TASTy Reflect can break type correctness guarantees and may fail at macro expansion time.
In this particular use case, we are safe because we are only interested in reading the syntax tree, not in its modification.
The `.asTerm` call produces the `Tree` instance. Similarly to `Expr`, the `Tree` has multiple subclasses that together represent our code.
For instance, the call `FieldName[NewYear](_.year)` is expanded to 
```scala
Inlined(EmptyTree,List(),Block(List(DefDef($anonfun,List(),List(List(ValDef(_$1,TypeTree[TypeRef(ThisType(TypeRef(NoPrefix,module class demo)),class NewYear)],EmptyTree))),TypeTree[TypeRef(TermRef(ThisType(TypeRef(NoPrefix,module class <root>)),module scala),Any)],Select(Ident(_$1),year))),Closure(List(),Ident($anonfun),EmptyTree)))
```

This AST has quite many nesting levels. That's why we use the `TreeAccumulator` that traverses this tree for us.
When the traversal reaches the desired `Select` instance, it returns the name of the field.

The `NewYear` has a method defined outside the constructor and in the current implementation the call `FieldName[NewYear](_.gift)` is perfectly valid. It returns the string `gift` even though the field is not defined in the primary constructor. 
In order to prevent any fields and methods to be passed into the `getName` method, we define a compile-time validation that issues a compilation error when the field is not a part of the primary constructor.
Here is the final implementation of the macro including the validation:
```scala
import scala.quoted.Expr.{ofTuple, summon}
import scala.quoted._

object FieldName {
  inline def apply[T](inline f: T => Any): String = ${getName('f)}

  private def getName[T](f: Expr[T => Any])(using Type[T], Quotes): Expr[String] = {
    import quotes.reflect._
    val acc = new TreeAccumulator[String] {
      def foldTree(names: String, tree: Tree)(owner: Symbol): String = tree match {
        case Select(_, name) => name
        case _ => foldOverTree(names, tree)(owner)
      }
    }
    val fieldName = acc.foldTree(null, f.asTerm)(Symbol.spliceOwner)
    val primaryConstructorFields = TypeTree.of[T].symbol.caseFields.map(_.name)
    if(!primaryConstructorFields.contains(fieldName))
      report.error(s"The field '$fieldName' is not one of the primary constructor parameter.", f)
    Expr(fieldName)
  }
}
```

Avoiding map construction. Type class derivation
-------------------

Earlier in this article, I mentioned that it is crucial to know how to derive the field name and omit to have the attribute names as strings.
The reason is that we will be generating the map based on the case class.
```scala
trait ItemCodec[T] {
  def encode(t: T): Map[String, AttributeValue]
}
```

There will be an instance of the `ItemCodec` trait created for any case class. Unlike `AttributeCodec`, which had the explicitly defined instances, the type `ItemCodec` instances are derived automatically.
In Scala 2 you would use libraries like Magnolia in order to construct the macros and generate these instances. Scala 3 introduces some convenience utilities in the language itself.
One of them is the trait `Mirror`. The language provides an instance of `Mirror.Product` for every case class. For our `NewYear` the implementation of this trait looks like this:
```scala
class NewYearMirror extends Mirror {
  type MirroredMonoType    = NewYear
  type MirroredLabel       = "NewYear"
  type MirroredElemLabels  = ("year", "wish")
  type MirroredElemTypes   = (Int, String)
}
```

What we need to do is go field by field, and encode every field into the format that the DynamoDb client understands:
- for every field get the `AttributeCodec`. For example, for the field `year` we need to summon an instance `AttributeCodec[Int]`
- set the encoded value in the map with the key `year`

`NewYearMirror` provides enough information to write such a type class derivation, because we have both field names and field types.
```scala
private inline def getAttributeNamesAndCodecs[N <: Tuple, T <: Tuple]: List[(String, AttributeCodec[Any])] =
  inline (erasedValue[N], erasedValue[T]) match {
    case (_: EmptyTuple, _: EmptyTuple) => Nil
    case (_: (nameHead *: nameTail), _: (typeHead *: typeTail)) =>
      val attributeLabel = constValue[nameHead].toString
      val attributeCodec = summonInline[AttributeCodec[typeHead]].asInstanceOf[AttributeCodec[Any]]
      (attributeLabel, attributeCodec) :: getAttributeNamesAndCodecs[nameTail, typeTail]
  }

inline given derived[T <: Product](using m: Mirror.ProductOf[T]): ItemCodec[T] = {
  val namesAndCodecs = getAttributeNamesAndCodecs[m.MirroredElemLabels, m.MirroredElemTypes]
  new ItemCodec[T] {
    override def encode(t: T): Map[String, AttributeValue] = {
      namesAndCodecs.zip(t.productIterator)
        .map { case ((name, codec), value) =>
          name -> codec.encode(value)
        }
        .toMap
    }
  }
}
```

The most interesting parts of these two methods are how to go over fields one by one, and how to transform the field type to be a value.

Let's understand the traversal first. We have a type `type MirroredElemLabels  = ("year", "wish")` which is a tuple. 
In Scala 3 there is an extractor for the tuple type `*:`. It works the same way as for sequences so that there are a head and a tail element. 
In order to pattern match the tuple, we need to have its value. The [erasedValue](https://dotty.epfl.ch/docs/reference/metaprogramming/inline.html#erasedvalue) pretends to give us the value.  In fact, it would always raise a NotImplementedError exception when called.
That's why we only pattern match the types and don't use the values of `erasedValue`.

The second puzzle is how it's possible to have the type of `"year"` instead of a type `String`, and how to transform the type `"year"` to the value `year`.
In Scala 3 there are singleton types that's why the type `"year"` is valid. These types have only one instance, in this case, `year`. In order to acquire this value we call the function `constValue`.

Convenience operators. Extension methods
-------------------

All the planned functional improvements have been implemented. We can only add some operators to the `GetItemRequest` and `PutItemRequest` as if they were natively scala.
Scala 2 approach is to define the implicit classes that wrap the objects and expose additional methods on them.
Scala 3 has a dedicated keyword for adding such operators. It's called [extension methods](https://dotty.epfl.ch/docs/reference/contextual/extension-methods.html).
```scala
extension[T] (b: GetItemRequest.Builder) {
  inline def key: GetItemRequestBuilderExtension[T] =
    new GetItemRequestBuilderExtension[T](b)
}

class GetItemRequestBuilderExtension[T](b: GetItemRequest.Builder) {
  inline def apply[A: AttributeCodec](inline k: T => A, v: A): GetItemRequest.Builder =
    b.key(Map(
      FieldName[T](k) -> AttributeCodec[A].encode(v)
    ).asJava)
}

extension[T: ItemCodec] (b: PutItemRequest.Builder) {
  def item(t: T): PutItemRequest.Builder =
    b.item(ItemCodec[T].encode(t).asJava)
}
```

Here is the resulting code that uses this syntactic sugar.
```scala
ddb.putItem(
  PutItemRequest.builder()
    .tableName(TableName)
    .item(year)
    .build()
)

val item = ddb.getItem(
  GetItemRequest.builder()
    .tableName(TableName)
    .key[NewYear](_.year, 2021)
    .build()
)
```

Conclusion
-------------------

In this article, we got acquainted with some Scala 3 features based on a real world example of using the DynamoDb client.
We also had a gentle introduction to the macros and type class derivations. If you need more information around this topic, then take a look at [this arctile](https://blog.philipp-martini.de/blog/magic-mirror-scala3/) 
and [the macro tutorial](https://lampepfl.github.io/scala3-macro-tutorial/).

The result of the exercise that is described in this article is in [github](https://github.com/melgenek/dotty-dynamodb).
